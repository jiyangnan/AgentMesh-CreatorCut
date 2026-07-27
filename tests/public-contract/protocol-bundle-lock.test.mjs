import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { protocolBundle } from "../../scripts/protocol-bundle.mjs";

const lock = JSON.parse(
  await readFile(
    new URL("../fixtures/protocol-v1.lock.json", import.meta.url),
    "utf8",
  ),
);

test("Protocol v1 bundle remains byte-for-byte frozen", async () => {
  const bundle = await protocolBundle();
  assert.equal(bundle.digest, lock.bundle_digest);
});
