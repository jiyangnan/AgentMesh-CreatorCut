import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

assert.equal(process.versions.node, "24.18.0", "Use Node.js 24.18.0");
const bundle = resolve(process.argv[2]);
const manifest = JSON.parse(
  await readFile(join(bundle, "manifest.json"), "utf8"),
);
assert.equal(manifest.version, "0.2.1");
assert.equal(manifest.server.entry_point, "server/main.mjs");
const executable = resolve(bundle, manifest.server.entry_point);
const code = await readFile(executable, "utf8");
assert(
  !/(?:\/Users\/|\/home\/)[^/\s]+\//u.test(code),
  "Local checkout path in artifact",
);
assert(!code.includes("/private/tmp/"), "Build path in artifact");
const root = await mkdtemp(join(tmpdir(), "creatorcut-mcp-bundle-smoke-"));
const project = join(root, "project");
const state = join(project, ".creatorcut");
const cwd = join(root, "empty-working-directory");
await mkdir(state, { recursive: true });
await mkdir(cwd);
const files = {
  "project.json": {
    schema_version: "1.0-alpha",
    project_id: "project-mcp-smoke",
    name: "MCP distribution smoke",
    revision: 4,
    assets: [
      {
        asset_id: "asset-1",
        kind: "video",
        relative_path: "source.mov",
        sha256: "c".repeat(64),
        duration_us: 1_000_000,
        width: 1920,
        height: 1080,
        has_video: true,
        has_audio: true,
      },
    ],
  },
  "timeline.json": {
    schema_version: "1.0-alpha",
    timeline_id: "timeline-1",
    project_id: "project-mcp-smoke",
    revision: 4,
    duration_us: 1_000_000,
    canvas: { width: 1920, height: 1080 },
    tracks: [
      {
        track_id: "video",
        kind: "video",
        clips: [
          {
            clip_id: "clip",
            asset_id: "asset-1",
            source_start_us: 0,
            source_end_us: 1_000_000,
            timeline_start_us: 0,
            timeline_end_us: 1_000_000,
          },
        ],
      },
    ],
  },
  "transcript.json": {
    schema_version: "1.0-alpha",
    transcript_id: "transcript-1",
    project_id: "project-mcp-smoke",
    revision: 4,
    language_mode: "en",
    segments: [
      {
        segment_id: "segment-1",
        source_asset_id: "asset-1",
        start_us: 0,
        end_us: 1_000_000,
        display_text: "Hello",
        tokens: [
          {
            token_id: "token-1",
            text: "Hello",
            start_us: 0,
            end_us: 1_000_000,
            language: "en",
            confidence: 1,
          },
        ],
      },
    ],
  },
  "edit-brief.json": {
    schema_version: "1.0-alpha",
    brief_id: "brief-1",
    project_id: "project-mcp-smoke",
    base_revision: 4,
    audio_mode: "original",
    caption_style_id: "caption_clean",
    approved: true,
  },
};
for (const [name, data] of Object.entries(files))
  await writeFile(join(state, name), JSON.stringify(data));
const digestState = async () => {
  const result = {};
  for (const name of (await readdir(state)).sort()) {
    result[name] = createHash("sha256")
      .update(await readFile(join(state, name)))
      .digest("hex");
  }
  return result;
};
const before = await digestState();
const child = spawn(process.execPath, [executable, "--project", project], {
  cwd,
  env: { PATH: process.env.PATH ?? "", CREATORCUT_HOST_TYPE: "text" },
  stdio: ["pipe", "pipe", "pipe"],
});
let sequence = 0;
let stdout = "";
let stderr = "";
const pending = new Map();
child.stderr.on("data", (chunk) => {
  stderr += String(chunk);
});
child.stdout.on("data", (chunk) => {
  stdout += String(chunk);
  while (stdout.includes("\n")) {
    const index = stdout.indexOf("\n");
    const line = stdout.slice(0, index);
    stdout = stdout.slice(index + 1);
    if (!line.trim()) continue;
    const response = JSON.parse(line);
    if (!pending.has(response.id)) continue;
    const { resolve: succeed, reject, timer } = pending.get(response.id);
    pending.delete(response.id);
    clearTimeout(timer);
    if (response.error) reject(new Error(JSON.stringify(response.error)));
    else succeed(response.result);
  }
});
child.on("error", (error) => {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
});
child.on("exit", (exitCode) => {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error(`Server exited ${exitCode}: ${stderr}`));
  }
  pending.clear();
});
const request = (method, params = {}) =>
  new Promise((succeed, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout: ${method}: ${stderr}`));
    }, 15_000);
    pending.set(id, { resolve: succeed, reject, timer });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
  });
try {
  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "creatorcut-distribution-smoke", version: "1.0.0" },
  });
  assert.equal(initialized.serverInfo.name, "creatorcut-mcp");
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );
  const tools = await request("tools/list");
  assert(tools.tools.some((tool) => tool.name === "creatorcut_project_status"));
  const status = await request("tools/call", {
    name: "creatorcut_project_status",
    arguments: {},
  });
  assert(!status.isError, JSON.stringify(status));
  assert.equal(
    status.structuredContent.project.project_id,
    "project-mcp-smoke",
  );
  assert.equal(status.structuredContent.project.revision, 4);
  assert.equal(status.structuredContent.project.director_consent, false);
  const context = await request("tools/call", {
    name: "creatorcut_director_context_inspect",
    arguments: {},
  });
  assert(!context.isError, JSON.stringify(context));
  assert(
    !JSON.stringify(context).includes(project),
    "Context exposed project path",
  );
  const resources = await request("resources/list");
  assert(resources.resources.length > 0);
  const widget = await request("resources/read", {
    uri: resources.resources[0].uri,
  });
  assert(
    widget.contents.some(
      (item) => item.mimeType === "text/html;profile=mcp-app",
    ),
  );
  assert.deepEqual(
    await digestState(),
    before,
    "Read-only tools changed project state",
  );
  console.log(
    JSON.stringify({
      status: "passed",
      node: process.versions.node,
      transport: "stdio",
      server: initialized.serverInfo,
      tools: tools.tools.length,
      resources: resources.resources.length,
      project_status: "passed",
      context_privacy: "passed",
      state_unchanged: true,
      paid_tools_called: 0,
      cwd_contains_repository: false,
    }),
  );
} finally {
  child.kill("SIGTERM");
  for (const request of pending.values()) clearTimeout(request.timer);
  await rm(root, { recursive: true, force: true });
}
