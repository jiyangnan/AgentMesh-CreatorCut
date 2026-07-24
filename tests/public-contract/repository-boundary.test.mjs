import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { protocolBundle } from "../../scripts/protocol-bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const excluded = new Set([".git", "node_modules", "dist", "coverage"]);
const forbidden = [
  ["/Users", "ferdinandji", "CreatorCut"].join("/"),
  ["packages", "planner"].join("/"),
  ["packages", "director-policy"].join("/"),
  ["X-Service", "Token"].join("-"),
  ["local", "data"].join("-"),
];

async function filesUnder(directory) {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    if (excluded.has(name)) continue;
    const path = join(directory, name);
    const metadata = await stat(path);
    if (metadata.isDirectory()) files.push(...(await filesUnder(path)));
    else if (metadata.isFile()) files.push(path);
  }
  return files;
}

test("protocol bundle is deterministic and populated", async () => {
  const first = await protocolBundle();
  const second = await protocolBundle();
  assert.deepEqual(first, second);
  assert.match(first.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(Object.keys(first.files).length >= 20);
});

test("public repository contains no private boundary markers", async () => {
  const violations = [];
  for (const path of await filesUnder(root)) {
    const content = await readFile(path, "utf8").catch(() => "");
    for (const needle of forbidden) {
      if (content.includes(needle)) {
        violations.push(`${path}: ${needle}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
