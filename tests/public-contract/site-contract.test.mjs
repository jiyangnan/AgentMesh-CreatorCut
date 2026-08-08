import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { validateSite } from "../../scripts/validate-site.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("public website preserves the product and trust boundary", () => {
  assert.deepEqual(validateSite(resolve(repositoryRoot, "site")), []);
});

test("public website links and indexes both editing guides", () => {
  const site = resolve(repositoryRoot, "site");
  const landing = readFileSync(resolve(site, "zh/index.html"), "utf8");
  const sitemap = readFileSync(resolve(site, "sitemap.xml"), "utf8");
  for (const route of [
    "/guides/talking-head-video-editing/",
    "/guides/screen-recording-editing/",
  ]) {
    const source = readFileSync(
      resolve(site, route.slice(1), "index.html"),
      "utf8",
    );
    const canonical = `https://creatorcut.agentmesh360.com${route}`;
    assert.ok(landing.includes(`href="${route}"`));
    assert.ok(source.includes(`href="${canonical}"`));
    assert.ok(source.includes('type="application/ld+json"'));
    assert.ok(sitemap.includes(`<loc>${canonical}</loc>`));
  }
});
