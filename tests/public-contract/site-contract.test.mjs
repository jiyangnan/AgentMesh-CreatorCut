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

const checkinLinks = {
  "index.html": ["https://agentmesh360.com/app/#check-in", "Check in"],
  "en/index.html": ["https://agentmesh360.com/app/#check-in", "Check in"],
  "zh/index.html": [
    "https://agentmesh360.com/app/?lang=zh-CN#check-in",
    "今日签到",
  ],
  "ja/index.html": [
    "https://agentmesh360.com/app/?lang=ja#check-in",
    "毎日チェックイン",
  ],
  "ko/index.html": [
    "https://agentmesh360.com/app/?lang=ko#check-in",
    "출석 체크",
  ],
};

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

test("all localized websites link to the central check-in page", () => {
  const site = resolve(repositoryRoot, "site");
  const styles = readFileSync(resolve(site, "assets/styles.css"), "utf8");
  const launchScript = readFileSync(resolve(site, "assets/site.js"), "utf8");
  assert.ok(styles.includes(".nav-checkin"));
  assert.ok(styles.includes(":not(.nav-checkin)"));
  assert.ok(styles.includes("flex-wrap: wrap"));

  for (const [relative, [href, label]] of Object.entries(checkinLinks)) {
    const source = readFileSync(resolve(site, relative), "utf8");
    assert.ok(source.includes(`href="${href}"`), relative);
    assert.ok(source.includes(`>${label}</a`), relative);
    assert.ok(source.includes('class="nav-checkin"'), relative);
    assert.ok(source.includes("data-checkin-link"), relative);
    assert.ok(source.includes('data-checkin-surface="creatorcut"'), relative);
    assert.ok(source.includes("data-checkin-complete-label="), relative);
  }
  assert.ok(launchScript.includes("event.origin !== checkinCoreOrigin"));
  assert.ok(
    launchScript.includes("event.source !== activeCheckinLaunch.popup"),
  );
  assert.ok(
    launchScript.includes("event.data?.request_id !== activeCheckinLaunch.id"),
  );
  assert.ok(launchScript.includes("window.location.assign(target.toString())"));
});
