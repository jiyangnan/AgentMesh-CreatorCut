import { isAbsolute } from "node:path";

import type { CliEnvelope } from "./types.js";

export const OPENCLAW_BRIDGE_ARGUMENT = "__openclaw-bridge";
export const OPENCLAW_BRIDGE_COMMAND = "creatorcut __openclaw-bridge" as const;
export const OPENCLAW_REQUEST_ENVIRONMENT = "CREATORCUT_OPENCLAW_REQUEST_JSON";
export const OPENCLAW_JSON_READY_MARKER =
  "CREATORCUT_OPENCLAW_JSON_READY" as const;
export const OPENCLAW_JSON_STDIN_MAXIMUM_BYTES = 4 * 1024 * 1024;

const OPENCLAW_REQUEST_MAXIMUM_BYTES = 8 * 1024;
const OPENCLAW_ARGV_MAXIMUM_ITEMS = 64;
const OPENCLAW_ARGUMENT_MAXIMUM_BYTES = 4 * 1024;
const OPENCLAW_JSON_STDIN_COMMANDS = new Set(["cards submit", "edit finalize"]);

export function isApiKeyArgument(value: string): boolean {
  return /^--key(?:=|$)/u.test(value);
}

const NEXT_PROCESS_ENVIRONMENT_KEYS = [
  "PATH",
  "CREATORCUT_INSTALL_DIR",
  "CREATORCUT_INSTALL_METADATA",
  "CREATORCUT_RELEASE_ENDPOINT",
  "CREATORCUT_RELEASE_KEYSET",
  "CREATORCUT_RELEASE_RECOVERY_ROOTS",
  "CREATORCUT_MINIMUM_RELEASE_KEYSET_VERSION",
  "CREATORCUT_DIRECTOR_ENDPOINT",
  "CREATORCUT_DIRECTOR_KEYSET",
  "CREATORCUT_DIRECTOR_RECOVERY_ROOTS",
  "CREATORCUT_MINIMUM_KEYSET_VERSION",
  "CREATORCUT_PROTOCOL_BUNDLE_DIGEST",
  "CREATORCUT_FFMPEG",
  "CREATORCUT_FFPROBE",
  "CREATORCUT_WHISPER",
  "CREATORCUT_WHISPER_MODEL",
  "CREATORCUT_KEYCHAIN_PATH",
  "CREATORCUT_DPAPI_PATH",
] as const;

interface NextProcessOptions {
  executable: string;
  mainModule: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
}

export interface OpenClawBridgeInvocation {
  argv: string[];
  stdinMode: "none" | "json-line-v1";
}

interface OpenClawTtyInput extends AsyncIterable<unknown> {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  resume: () => unknown;
  pause: () => unknown;
}

export async function readOpenClawJsonLine(
  input: OpenClawTtyInput,
  ready: () => void,
): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new TypeError(
      "CreatorCut OpenClaw JSON input requires a PTY-backed background exec session",
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  input.setRawMode(true);
  try {
    input.resume();
    ready();
    for await (const chunkValue of input) {
      const chunk = Buffer.isBuffer(chunkValue)
        ? chunkValue
        : Buffer.from(String(chunkValue));
      const carriageReturn = chunk.indexOf(13);
      const lineFeed = chunk.indexOf(10);
      const delimiter =
        carriageReturn === -1
          ? lineFeed
          : lineFeed === -1
            ? carriageReturn
            : Math.min(carriageReturn, lineFeed);
      const content = delimiter === -1 ? chunk : chunk.subarray(0, delimiter);
      total += content.length;
      if (total > OPENCLAW_JSON_STDIN_MAXIMUM_BYTES) {
        throw new TypeError("CreatorCut OpenClaw JSON input is too large");
      }
      chunks.push(content);
      if (delimiter !== -1) {
        const trailing = chunk.subarray(delimiter + 1);
        const allowedPairedDelimiter =
          trailing.length === 1 &&
          ((chunk[delimiter] === 13 && trailing[0] === 10) ||
            (chunk[delimiter] === 10 && trailing[0] === 13));
        if (trailing.length > 0 && !allowedPairedDelimiter) {
          throw new TypeError(
            "CreatorCut OpenClaw JSON input must contain exactly one line",
          );
        }
        return Buffer.concat(chunks).toString("utf8");
      }
    }
    throw new TypeError("CreatorCut OpenClaw JSON input ended before submit");
  } finally {
    try {
      input.setRawMode(false);
    } catch {
      // The PTY may already have closed; the process is exiting either way.
    }
    input.pause();
  }
}

function consumeEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  const matchingNames = Object.keys(environment).filter((candidate) =>
    platform === "win32"
      ? candidate.toUpperCase() === name
      : candidate === name,
  );
  if (matchingNames.length > 1) {
    throw new TypeError(
      `CreatorCut OpenClaw bridge environment contains duplicate ${name} keys`,
    );
  }
  const actualName = matchingNames[0];
  if (!actualName) return undefined;
  const value = environment[actualName];
  delete environment[actualName];
  return value;
}

function commandName(argv: string[]): string {
  const command: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) {
      command.push(value);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) index += 1;
  }
  return command.slice(0, 2).join(" ");
}

export function resolveOpenClawBridgeInvocation(
  processArguments: string[],
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): OpenClawBridgeInvocation | undefined {
  const rawRequest = consumeEnvironmentValue(
    environment,
    OPENCLAW_REQUEST_ENVIRONMENT,
    platform,
  );
  const bridgeRequested =
    processArguments.length === 1 &&
    processArguments[0] === OPENCLAW_BRIDGE_ARGUMENT;
  if (!bridgeRequested) {
    if (rawRequest !== undefined) {
      throw new TypeError(
        "CreatorCut OpenClaw bridge environment requires the fixed bridge command",
      );
    }
    return undefined;
  }
  if (rawRequest === undefined) {
    throw new TypeError(
      `CreatorCut OpenClaw bridge requires ${OPENCLAW_REQUEST_ENVIRONMENT}`,
    );
  }
  if (Buffer.byteLength(rawRequest, "utf8") > OPENCLAW_REQUEST_MAXIMUM_BYTES) {
    throw new TypeError("CreatorCut OpenClaw bridge request is too large");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawRequest);
  } catch {
    throw new TypeError(
      "CreatorCut OpenClaw bridge request must be valid JSON",
    );
  }
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    Array.isArray(decoded) ||
    Object.keys(decoded).toSorted().join(",") !== "argv,stdin_mode"
  ) {
    throw new TypeError(
      "CreatorCut OpenClaw bridge request must contain only argv and stdin_mode",
    );
  }
  const request = decoded as { argv?: unknown; stdin_mode?: unknown };
  if (
    !Array.isArray(request.argv) ||
    request.argv.length === 0 ||
    request.argv.length > OPENCLAW_ARGV_MAXIMUM_ITEMS ||
    request.argv.some(
      (value) =>
        typeof value !== "string" ||
        value.includes("\0") ||
        Buffer.byteLength(value, "utf8") > OPENCLAW_ARGUMENT_MAXIMUM_BYTES,
    )
  ) {
    throw new TypeError(
      "CreatorCut OpenClaw bridge argv must be a bounded non-empty string array",
    );
  }
  const argv = request.argv as string[];
  if (argv[0] === OPENCLAW_BRIDGE_ARGUMENT) {
    throw new TypeError("CreatorCut OpenClaw bridge recursion is not allowed");
  }
  if (argv.some(isApiKeyArgument)) {
    throw new TypeError("CreatorCut OpenClaw bridge never accepts API keys");
  }
  const name = commandName(argv);
  if (name === "auth login") {
    throw new TypeError(
      "CreatorCut OpenClaw bridge never transports API keys; run creatorcut auth login in a user-controlled terminal",
    );
  }
  const stdinMode = request.stdin_mode;
  if (stdinMode !== "none" && stdinMode !== "json-line-v1") {
    throw new TypeError("CreatorCut OpenClaw bridge stdin mode is invalid");
  }
  const requiresJsonInput = OPENCLAW_JSON_STDIN_COMMANDS.has(name);
  if (requiresJsonInput !== (stdinMode === "json-line-v1")) {
    throw new TypeError(
      requiresJsonInput
        ? "CreatorCut OpenClaw bridge requires json-line-v1 input for this command"
        : "CreatorCut OpenClaw bridge accepts JSON input only for cards submit and edit finalize",
    );
  }
  return { argv, stdinMode };
}

function openClawContinuation(
  argv: string[],
  cwd: string,
): CliEnvelope["next_openclaw"] | undefined {
  const name = commandName(argv);
  if (name === "auth login") return undefined;
  const jsonInput = OPENCLAW_JSON_STDIN_COMMANDS.has(name);
  return {
    exec: {
      command: OPENCLAW_BRIDGE_COMMAND,
      workdir: cwd,
      env: {
        [OPENCLAW_REQUEST_ENVIRONMENT]: JSON.stringify({
          argv,
          stdin_mode: jsonInput ? "json-line-v1" : "none",
        }),
      },
      pty: jsonInput,
      background: jsonInput,
    },
    input: jsonInput
      ? {
          mode: "json-line-v1",
          ready_marker: OPENCLAW_JSON_READY_MARKER,
          maximum_utf8_bytes: OPENCLAW_JSON_STDIN_MAXIMUM_BYTES,
        }
      : { mode: "none" },
  };
}

function environmentEntry(
  environment: NodeJS.ProcessEnv,
  name: string,
): [string, string] | undefined {
  let actualName = name;
  if (name === "PATH" && process.platform === "win32") {
    actualName =
      Object.keys(environment).find(
        (candidate) => candidate.toUpperCase() === "PATH",
      ) ?? name;
  }
  const value = environment[actualName];
  return value === undefined ? undefined : [actualName, value];
}

export function withNextProcess<T>(
  envelope: CliEnvelope<T>,
  options: NextProcessOptions,
): CliEnvelope<T> {
  if (!envelope.next_argv) return envelope;
  if (
    !isAbsolute(options.executable) ||
    !isAbsolute(options.mainModule) ||
    !isAbsolute(options.cwd)
  ) {
    throw new TypeError(
      "CreatorCut next-process executable, main module, and cwd must be absolute paths",
    );
  }
  const envOverrides: Record<string, string> = {};
  for (const name of NEXT_PROCESS_ENVIRONMENT_KEYS) {
    const entry = environmentEntry(options.environment, name);
    if (entry) envOverrides[entry[0]] = entry[1];
  }
  const nextOpenClaw = openClawContinuation(envelope.next_argv, options.cwd);
  return {
    ...envelope,
    next_process: {
      executable: options.executable,
      argv: [options.mainModule, ...envelope.next_argv],
      cwd: options.cwd,
      env_overrides: envOverrides,
      shell: false,
    },
    ...(nextOpenClaw ? { next_openclaw: nextOpenClaw } : {}),
  };
}
