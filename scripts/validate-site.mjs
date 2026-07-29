#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_INSTALL_COMMANDS = [
  "curl -fsSL https://raw.githubusercontent.com/jiyangnan/AgentMesh-CreatorCut/main/scripts/install.sh | bash",
  "irm https://raw.githubusercontent.com/jiyangnan/AgentMesh-CreatorCut/main/scripts/install.ps1 | iex",
];

function htmlFiles(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      files.push(...htmlFiles(path));
    } else if (entry.endsWith(".html")) {
      files.push(path);
    }
  }
  return files;
}

function attributeValues(html, attribute) {
  const values = [];
  const pattern = new RegExp(`\\b${attribute}=["']([^"']+)["']`, "giu");
  for (const match of html.matchAll(pattern)) values.push(match[1]);
  return values;
}

function localTarget(root, page, reference) {
  const withoutQuery = reference.split(/[?#]/u, 1)[0];
  if (!withoutQuery || reference.startsWith("#")) return null;
  if (/^(?:[a-z]+:|\/\/)/iu.test(withoutQuery)) return null;
  const relative = withoutQuery.startsWith("/")
    ? withoutQuery.slice(1)
    : posix.normalize(posix.join(posix.dirname(page), withoutQuery));
  const candidate = resolve(root, relative);
  const canonicalRoot = resolve(root);
  if (
    !candidate.startsWith(`${canonicalRoot}/`) &&
    candidate !== canonicalRoot
  ) {
    return "__escape__";
  }
  return withoutQuery.endsWith("/") ? join(candidate, "index.html") : candidate;
}

export function validateSite(rootInput) {
  const root = resolve(rootInput);
  const errors = [];
  const requiredPages = [
    ["index.html", "zh-CN"],
    ["en/index.html", "en"],
  ];

  for (const [page, expectedLanguage] of requiredPages) {
    const path = join(root, page);
    if (!existsSync(path)) {
      errors.push(`${page}: required page is missing`);
      continue;
    }
    const html = readFileSync(path, "utf8");
    const language = html.match(/<html\b[^>]*\blang=["']([^"']+)["']/iu)?.[1];
    if (language !== expectedLanguage) {
      errors.push(`${page}: expected lang=${expectedLanguage}`);
    }
    if ((html.match(/<title\b/giu) ?? []).length !== 1) {
      errors.push(`${page}: expected exactly one title`);
    }
    if (!html.includes("AgentMesh-CreatorCut")) {
      errors.push(`${page}: unified public product name is missing`);
    }
    if (
      !html.includes('data-product-contract="local-media-paid-director-v1"')
    ) {
      errors.push(`${page}: product boundary contract is missing`);
    }
    const directorRoute =
      html.match(
        /data-route=["']director["'][\s\S]{0,240}data-access=["']paid["'][\s\S]{0,240}data-media=["']local["']/giu,
      ) ?? [];
    if (directorRoute.length !== 1) {
      errors.push(`${page}: expected one paid Director/local-media route`);
    }
    for (const command of REQUIRED_INSTALL_COMMANDS) {
      if (!html.includes(command)) {
        errors.push(`${page}: exact install command is missing`);
      }
    }
    const hero = html.match(
      /<section\b[^>]*class=["'][^"']*\bhero\b[^"']*["'][^>]*>([\s\S]*?)<\/section>/iu,
    )?.[1];
    if (
      !hero ||
      !hero.includes('href="#quick-install"') ||
      !hero.includes('id="quick-install"') ||
      !hero.includes(REQUIRED_INSTALL_COMMANDS[0])
    ) {
      errors.push(
        `${page}: hero must keep the macOS command beside the install CTA`,
      );
    }
    if (
      !html.includes("creatorcut onboard") ||
      !html.includes('class="onboard-flow"')
    ) {
      errors.push(`${page}: post-install Agent onboarding journey is missing`);
    }
    if (!html.includes(">50 <") && !html.includes(">50<")) {
      errors.push(`${page}: 50-credit price is missing`);
    }

    const ids = attributeValues(html, "id");
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    for (const duplicate of new Set(duplicates)) {
      errors.push(`${page}: duplicate id ${duplicate}`);
    }

    for (const reference of [
      ...attributeValues(html, "href"),
      ...attributeValues(html, "src"),
    ]) {
      const target = localTarget(root, page, reference);
      if (target === null) continue;
      if (target === "__escape__" || !existsSync(target)) {
        errors.push(`${page}: broken local reference ${reference}`);
      }
    }

    const jsonLdBlocks = [
      ...html.matchAll(
        /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu,
      ),
    ];
    if (jsonLdBlocks.length !== 1) {
      errors.push(`${page}: expected exactly one JSON-LD block`);
    }
    for (const block of jsonLdBlocks) {
      try {
        JSON.parse(block[1]);
      } catch {
        errors.push(`${page}: JSON-LD is invalid`);
      }
    }
  }

  for (const page of htmlFiles(root)) {
    const html = readFileSync(page, "utf8");
    if (/creatorcut-server|CLIENT_RELEASE_SIGNING_KEYS_JSON/iu.test(html)) {
      errors.push(`${page}: private implementation detail leaked`);
    }
  }

  for (const asset of [
    "assets/styles.css",
    "assets/site.js",
    "favicon.svg",
    "robots.txt",
    "sitemap.xml",
    "llms.txt",
  ]) {
    if (!existsSync(join(root, asset))) {
      errors.push(`${asset}: required site asset is missing`);
    }
  }

  return errors;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const siteRoot = process.argv[2] ?? "site";
  const errors = validateSite(siteRoot);
  if (errors.length > 0) {
    for (const error of errors) console.error(`site contract: ${error}`);
    process.exitCode = 1;
  } else {
    console.log("AgentMesh-CreatorCut site contract: OK");
  }
}
