#!/usr/bin/env node
import { executeCli } from "./command.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const result = await executeCli(process.argv.slice(2), {
  stdin: readStdin,
  stdout: (value) => process.stdout.write(value),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.ok ? 0 : 1;
