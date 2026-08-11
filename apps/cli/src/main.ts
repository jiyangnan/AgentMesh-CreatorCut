#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import type { CliEnvelope } from "./types.js";
import {
  OPENCLAW_JSON_READY_MARKER,
  readOpenClawJsonLine,
  resolveOpenClawBridgeInvocation,
  withNextProcess,
} from "./next-process.js";

const inheritedWarningListeners = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (
    warning.name === "ExperimentalWarning" &&
    warning.message ===
      "SQLite is an experimental feature and might change at any time"
  ) {
    return;
  }
  for (const listener of inheritedWarningListeners) {
    listener.call(process, warning);
  }
});

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function bridgeFailure(error: unknown): CliEnvelope {
  return {
    schema_version: "creatorcut-cli/1.0",
    ok: false,
    command: "openclaw bridge",
    requires_user_action: false,
    retryable: false,
    error: {
      code: "invalid_input",
      message:
        error instanceof Error
          ? error.message
          : "CreatorCut OpenClaw bridge failed",
    },
  };
}

function openClawSkillMismatch(): CliEnvelope {
  return {
    schema_version: "creatorcut-cli/1.0",
    ok: false,
    command: "openclaw compatibility",
    requires_user_action: true,
    user_prompt:
      "Use the --force replacement command in skills/openclaw-creatorcut/README.md from the same verified release archive, then retry through the fixed creatorcut __openclaw-bridge command. Do not follow next_suggested as an executable command.",
    retryable: false,
    error: {
      code: "invalid_input",
      message:
        "This OpenClaw invocation did not use the matching CreatorCut fixed bridge contract",
    },
  };
}

async function main(): Promise<void> {
  const processArguments = process.argv.slice(2);
  let bridge;
  try {
    bridge = resolveOpenClawBridgeInvocation(processArguments, process.env);
  } catch (error) {
    const result = bridgeFailure(error);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  if (process.env.OPENCLAW_SHELL === "exec" && !bridge) {
    const result = openClawSkillMismatch();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const { executeCli } = await import("./command.js");
  const commandResult = await executeCli(bridge?.argv ?? processArguments, {
    stdin:
      bridge?.stdinMode === "json-line-v1"
        ? () =>
            readOpenClawJsonLine(process.stdin, () =>
              process.stderr.write(`${OPENCLAW_JSON_READY_MARKER}\n`),
            )
        : bridge
          ? async () => ""
          : readStdin,
    stdout: (value) => process.stdout.write(value),
  });
  const result = withNextProcess(commandResult, {
    executable: process.execPath,
    mainModule: fileURLToPath(import.meta.url),
    cwd: process.cwd(),
    environment: process.env,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

await main();
