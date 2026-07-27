import { spawn } from "node:child_process";

const DEFAULT_SERVICE = "com.agentmesh.creatorcut";
const DEFAULT_ACCOUNT = "agentmesh-api-key";

export interface CredentialStore {
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

function assertApiKey(apiKey: string): string {
  const normalized = apiKey.trim();
  if (!normalized || /\s/u.test(normalized)) {
    throw new TypeError(
      "AgentMesh API key must be non-empty and contain no whitespace",
    );
  }
  return normalized;
}

function defaultRunner(): KeychainCommandRunner {
  return {
    run(args, options = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn("/usr/bin/security", [...args], {
          stdio: ["pipe", "pipe", "pipe"],
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
          reject(
            new Error(
              `macOS Keychain command failed with exit ${result.exitCode}`,
            ),
          );
        });
        if (options.stdin !== undefined) {
          child.stdin.end(`${options.stdin}\n`);
        } else {
          child.stdin.end();
        }
      });
    },
  };
}

export class KeychainCredentialStore implements CredentialStore {
  readonly #service: string;
  readonly #account: string;
  readonly #runner: KeychainCommandRunner;

  constructor(
    options: {
      service?: string;
      account?: string;
      runner?: KeychainCommandRunner;
    } = {},
  ) {
    if (process.platform !== "darwin" && options.runner === undefined) {
      throw new Error("CreatorCut Keychain storage requires macOS");
    }
    this.#service = options.service ?? DEFAULT_SERVICE;
    this.#account = options.account ?? DEFAULT_ACCOUNT;
    this.#runner = options.runner ?? defaultRunner();
  }

  async setApiKey(apiKey: string): Promise<void> {
    const secret = assertApiKey(apiKey);
    // `-w` deliberately remains the last argument with no value. The security
    // tool reads the password from stdin, so the API key never enters argv.
    await this.#runner.run(
      [
        "add-generic-password",
        "-a",
        this.#account,
        "-s",
        this.#service,
        "-U",
        "-w",
      ],
      { stdin: secret },
    );
  }

  async getApiKey(): Promise<string | null> {
    const result = await this.#runner.run(
      ["find-generic-password", "-a", this.#account, "-s", this.#service, "-w"],
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
      ["delete-generic-password", "-a", this.#account, "-s", this.#service],
      { allowMissing: true },
    );
    return result.exitCode === 0;
  }
}

export class MemoryCredentialStore implements CredentialStore {
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
