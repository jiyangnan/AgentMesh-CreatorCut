import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { operationsBundle } from "../../scripts/operations-bundle.mjs";

const lock = JSON.parse(
  await readFile(
    new URL(
      "../../packages/operations-contract/contract-lock.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

test("operations contract bundle is deterministic and contains schema plus vectors", async () => {
  const first = await operationsBundle();
  const second = await operationsBundle();
  assert.deepEqual(first, second);
  assert.match(first.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(first.files), [
    "schemas/edit-operation-contract.schema.json",
    "vectors/operation-vectors.json",
  ]);
  assert.equal(first.digest, lock.bundle_digest);
});
