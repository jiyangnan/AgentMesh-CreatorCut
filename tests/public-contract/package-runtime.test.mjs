import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const protocolRoot = resolve(root, "packages", "protocol");

test("compiled protocol is a standalone Node 24 ESM package", async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(protocolRoot, "package.json"), "utf8"),
  );
  assert.equal(packageJson.exports["."].import, "./dist/src/index.js");
  assert.equal(packageJson.exports["."].types, "./dist/src/index.d.ts");

  const entry = resolve(protocolRoot, "dist", "src", "index.js");
  const declaration = resolve(protocolRoot, "dist", "src", "index.d.ts");
  const contextSchema = resolve(
    protocolRoot,
    "dist",
    "schemas",
    "director-context.schema.json",
  );
  await Promise.all([
    access(entry),
    access(declaration),
    access(contextSchema),
  ]);

  const protocol = await import(pathToFileURL(entry).href);
  assert.equal(protocol.DIRECTOR_PROTOCOL_VERSION, "1.0");
  assert.equal(
    protocol.CREATORCUT_LIMITS_V1.limits_version,
    "creatorcut-limits/1.0",
  );
});
