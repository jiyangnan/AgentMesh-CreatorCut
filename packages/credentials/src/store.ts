import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const DEFAULT_SERVICE = "com.agentmesh.creatorcut";
const DEFAULT_ACCOUNT = "agentmesh-api-key";
const WINDOWS_STORAGE = "Windows DPAPI";
const LINUX_STORAGE = "Linux Secret Service";
const MACOS_STORAGE = "macOS Keychain";

export interface CredentialStore {
  readonly storage: string;
  setApiKey(apiKey: string): Promise<void>;
  getApiKey(): Promise<string | null>;
  hasApiKey(): Promise<boolean>;
  deleteApiKey(): Promise<boolean>;
}

export interface KeychainCommandRunner {
  run(
    args: readonly string[],
    options?: {
      stdin?: string | undefined;
      allowMissing?: boolean | undefined;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface PowerShellCommandRunner {
  run(
    script: string,
    options?: {
      stdin?: string | undefined;
      allowMissing?: boolean | undefined;
      environment?: NodeJS.ProcessEnv | undefined;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface SecretToolCommandRunner {
  run(
    args: readonly string[],
    options?: {
      stdin?: string | undefined;
      allowMissing?: boolean | undefined;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

function assertApiKey(apiKey: string): string {
  const normalized = apiKey.trim();
  if (!normalized || !/^[A-Za-z0-9_-]+$/u.test(normalized)) {
    throw new TypeError(
      "AgentMesh API key must use the URL-safe Core key format",
    );
  }
  return normalized;
}

function assertIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new TypeError(`AgentMesh-CreatorCut credential ${label} is invalid`);
  }
  return value;
}

function assertAbsolutePath(value: string | undefined, label: string) {
  if (value === undefined) return undefined;
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`AgentMesh-CreatorCut ${label} path is invalid`);
  }
  return value;
}

function commandRunner(
  command: string,
  errorLabel: string,
): (
  args: readonly string[],
  options?: {
    stdin?: string | undefined;
    allowMissing?: boolean | undefined;
    environment?: NodeJS.ProcessEnv | undefined;
  },
) => Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return (args, options = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        env: options.environment ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (exitCode) => {
        const result = { stdout, stderr, exitCode: exitCode ?? 1 };
        if (result.exitCode === 0 || options.allowMissing) {
          resolve(result);
          return;
        }
        reject(new Error(`${errorLabel} failed with exit ${result.exitCode}`));
      });
      child.stdin.end(options.stdin);
    });
}

function defaultKeychainRunner(): KeychainCommandRunner {
  const run = commandRunner("/usr/bin/security", "macOS Keychain command");
  return {
    run(args, options) {
      return run(args, options);
    },
  };
}

function assertKeychainPath(value: string | undefined): string | undefined {
  const path = assertAbsolutePath(value, "Keychain");
  if (path !== undefined && !/^\/[A-Za-z0-9/._-]+$/u.test(path)) {
    throw new TypeError("AgentMesh-CreatorCut Keychain path is invalid");
  }
  return path;
}

export class KeychainCredentialStore implements CredentialStore {
  readonly storage = MACOS_STORAGE;
  readonly #service: string;
  readonly #account: string;
  readonly #keychainPath: string | undefined;
  readonly #runner: KeychainCommandRunner;

  constructor(
    options: {
      service?: string;
      account?: string;
      keychainPath?: string;
      runner?: KeychainCommandRunner;
    } = {},
  ) {
    if (process.platform !== "darwin" && options.runner === undefined) {
      throw new Error(
        "AgentMesh-CreatorCut macOS Keychain storage requires macOS",
      );
    }
    this.#service = assertIdentifier(
      options.service ?? DEFAULT_SERVICE,
      "service",
    );
    this.#account = assertIdentifier(
      options.account ?? DEFAULT_ACCOUNT,
      "account",
    );
    this.#keychainPath = assertKeychainPath(options.keychainPath);
    this.#runner = options.runner ?? defaultKeychainRunner();
  }

  async setApiKey(apiKey: string): Promise<void> {
    const secret = assertApiKey(apiKey);
    await this.#runner.run(["-i"], {
      stdin: `add-generic-password -a ${this.#account} -s ${this.#service} -U -w ${secret}${
        this.#keychainPath === undefined ? "" : ` ${this.#keychainPath}`
      }\n`,
    });
  }

  async getApiKey(): Promise<string | null> {
    const result = await this.#runner.run(
      [
        "find-generic-password",
        "-a",
        this.#account,
        "-s",
        this.#service,
        "-w",
        ...(this.#keychainPath === undefined ? [] : [this.#keychainPath]),
      ],
      { allowMissing: true },
    );
    if (result.exitCode !== 0) return null;
    return assertApiKey(result.stdout);
  }

  async hasApiKey(): Promise<boolean> {
    return (await this.getApiKey()) !== null;
  }

  async deleteApiKey(): Promise<boolean> {
    const result = await this.#runner.run(
      [
        "delete-generic-password",
        "-a",
        this.#account,
        "-s",
        this.#service,
        ...(this.#keychainPath === undefined ? [] : [this.#keychainPath]),
      ],
      { allowMissing: true },
    );
    return result.exitCode === 0;
  }
}

const WINDOWS_SET_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$path = $env:CREATORCUT_DPAPI_PATH
$secret = [Console]::In.ReadToEnd().Trim()
if (-not $secret) { throw "AgentMesh API key is empty" }
$directory = Split-Path -Parent $path
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$bytes = [Text.Encoding]::UTF8.GetBytes($secret)
$protected = [Security.Cryptography.ProtectedData]::Protect(
  $bytes,
  $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
$temporary = "$path.next-$PID"
[IO.File]::WriteAllText(
  $temporary,
  [Convert]::ToBase64String($protected),
  [Text.UTF8Encoding]::new($false)
)
Move-Item -Force -LiteralPath $temporary -Destination $path
`;

const WINDOWS_GET_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$path = $env:CREATORCUT_DPAPI_PATH
if (-not (Test-Path -LiteralPath $path)) { exit 3 }
$encoded = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8).Trim()
$protected = [Convert]::FromBase64String($encoded)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect(
  $protected,
  $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`;

const WINDOWS_DELETE_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$path = $env:CREATORCUT_DPAPI_PATH
if (-not (Test-Path -LiteralPath $path)) { exit 3 }
Remove-Item -Force -LiteralPath $path
`;

function defaultPowerShellRunner(): PowerShellCommandRunner {
  const executable =
    process.env.SystemRoot === undefined
      ? "powershell.exe"
      : join(
          process.env.SystemRoot,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        );
  const run = commandRunner(executable, "Windows DPAPI command");
  return {
    run(script, options) {
      return run(
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          script,
        ],
        options,
      );
    },
  };
}

export class WindowsDpapiCredentialStore implements CredentialStore {
  readonly storage = WINDOWS_STORAGE;
  readonly #path: string;
  readonly #runner: PowerShellCommandRunner;

  constructor(
    options: { path?: string; runner?: PowerShellCommandRunner } = {},
  ) {
    if (process.platform !== "win32" && options.runner === undefined) {
      throw new Error("AgentMesh-CreatorCut DPAPI storage requires Windows");
    }
    const base =
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    this.#path =
      assertAbsolutePath(options.path, "DPAPI") ??
      join(base, "AgentMesh", "CreatorCut", "credentials", "api-key.dpapi");
    this.#runner = options.runner ?? defaultPowerShellRunner();
  }

  #environment(): NodeJS.ProcessEnv {
    return { ...process.env, CREATORCUT_DPAPI_PATH: this.#path };
  }

  async setApiKey(apiKey: string): Promise<void> {
    await this.#runner.run(WINDOWS_SET_SCRIPT, {
      stdin: assertApiKey(apiKey),
      environment: this.#environment(),
    });
  }

  async getApiKey(): Promise<string | null> {
    const result = await this.#runner.run(WINDOWS_GET_SCRIPT, {
      allowMissing: true,
      environment: this.#environment(),
    });
    if (result.exitCode !== 0) return null;
    return assertApiKey(result.stdout);
  }

  async hasApiKey(): Promise<boolean> {
    return (await this.getApiKey()) !== null;
  }

  async deleteApiKey(): Promise<boolean> {
    const result = await this.#runner.run(WINDOWS_DELETE_SCRIPT, {
      allowMissing: true,
      environment: this.#environment(),
    });
    return result.exitCode === 0;
  }
}

function defaultSecretToolRunner(): SecretToolCommandRunner {
  const run = commandRunner("secret-tool", "Linux Secret Service command");
  return {
    run(args, options) {
      return run(args, options);
    },
  };
}

export class LinuxSecretServiceCredentialStore implements CredentialStore {
  readonly storage = LINUX_STORAGE;
  readonly #service: string;
  readonly #account: string;
  readonly #runner: SecretToolCommandRunner;

  constructor(
    options: {
      service?: string;
      account?: string;
      runner?: SecretToolCommandRunner;
    } = {},
  ) {
    if (process.platform !== "linux" && options.runner === undefined) {
      throw new Error(
        "AgentMesh-CreatorCut Secret Service storage requires Linux",
      );
    }
    this.#service = assertIdentifier(
      options.service ?? DEFAULT_SERVICE,
      "service",
    );
    this.#account = assertIdentifier(
      options.account ?? DEFAULT_ACCOUNT,
      "account",
    );
    this.#runner = options.runner ?? defaultSecretToolRunner();
  }

  async setApiKey(apiKey: string): Promise<void> {
    await this.#runner.run(
      [
        "store",
        "--label=AgentMesh-CreatorCut API Key",
        "service",
        this.#service,
        "account",
        this.#account,
      ],
      { stdin: `${assertApiKey(apiKey)}\n` },
    );
  }

  async getApiKey(): Promise<string | null> {
    const result = await this.#runner.run(
      ["lookup", "service", this.#service, "account", this.#account],
      { allowMissing: true },
    );
    if (result.exitCode !== 0 || result.stdout.trim() === "") return null;
    return assertApiKey(result.stdout);
  }

  async hasApiKey(): Promise<boolean> {
    return (await this.getApiKey()) !== null;
  }

  async deleteApiKey(): Promise<boolean> {
    const existed = await this.hasApiKey();
    if (!existed) return false;
    await this.#runner.run([
      "clear",
      "service",
      this.#service,
      "account",
      this.#account,
    ]);
    return true;
  }
}

export function createPlatformCredentialStore(
  platform: NodeJS.Platform = process.platform,
): CredentialStore {
  if (platform === "darwin") {
    return new KeychainCredentialStore({
      ...(process.env.CREATORCUT_KEYCHAIN_PATH
        ? { keychainPath: process.env.CREATORCUT_KEYCHAIN_PATH }
        : {}),
    });
  }
  if (platform === "win32") {
    return new WindowsDpapiCredentialStore({
      ...(process.env.CREATORCUT_DPAPI_PATH
        ? { path: process.env.CREATORCUT_DPAPI_PATH }
        : {}),
    });
  }
  if (platform === "linux") {
    return new LinuxSecretServiceCredentialStore();
  }
  throw new Error(
    `AgentMesh-CreatorCut does not support credential storage on ${platform}`,
  );
}

export class MemoryCredentialStore implements CredentialStore {
  readonly storage = "memory";
  #apiKey: string | null = null;

  async setApiKey(apiKey: string): Promise<void> {
    this.#apiKey = assertApiKey(apiKey);
  }

  async getApiKey(): Promise<string | null> {
    return this.#apiKey;
  }

  async hasApiKey(): Promise<boolean> {
    return this.#apiKey !== null;
  }

  async deleteApiKey(): Promise<boolean> {
    const existed = this.#apiKey !== null;
    this.#apiKey = null;
    return existed;
  }
}
