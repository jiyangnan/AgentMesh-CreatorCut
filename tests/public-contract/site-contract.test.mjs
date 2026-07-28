import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { validateSite } from "../../scripts/validate-site.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("public website preserves the product and trust boundary", () => {
  assert.deepEqual(validateSite(resolve(repositoryRoot, "site")), []);
});
