import { spawn } from "node:child_process";

import type { ProcessResult, ProcessRunner } from "./types.js";

export const runProcess: ProcessRunner = async (
  command,
  args,
  signal,
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      signal,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
