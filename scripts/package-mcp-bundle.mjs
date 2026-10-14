import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const SOURCE_COMMIT = "4305b1e201f602fb769ae4973c2b37efbf62e923";
const SOURCE_SHA256 =
  "21b10149fa720f753e3f90371c399ed13c01227b5481dd013845bcee200972b5";
const VERSION = "0.2.1";
const NAME = "io.github.jiyangnan/creatorcut";
const options = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, args) => {
    if (index % 2 === 0) pairs.push([value, args[index + 1]]);
    return pairs;
  }, []),
);
for (const flag of ["--source", "--archive", "--tools", "--output"]) {
  assert(options[flag], `${flag} is required`);
}
assert.equal(process.versions.node, "24.18.0", "Use Node.js 24.18.0");
const source = resolve(options["--source"]);
const archive = resolve(options["--archive"]);
const tools = resolve(options["--tools"]);
const output = resolve(options["--output"]);
assert.equal(
  createHash("sha256")
    .update(await readFile(archive))
    .digest("hex"),
  SOURCE_SHA256,
  "Source archive must match the Core-approved v0.2.1 release",
);
execFileSync(
  "python3",
  [
    "-c",
    `import sys, tarfile, pathlib
root=pathlib.Path(sys.argv[2]).resolve()
with tarfile.open(sys.argv[1]) as tar:
 for member in tar:
  target=(root/member.name).resolve()
  if not target.is_relative_to(root): raise ValueError('Source path escape')
  if member.isfile() and target.read_bytes()!=tar.extractfile(member).read():
   raise ValueError('Source differs from approved archive: '+member.name)
`,
    archive,
    source,
  ],
  { stdio: "inherit" },
);
execFileSync("pnpm", ["--filter", "@agentmesh/creatorcut-mcp...", "build"], {
  cwd: source,
  stdio: "inherit",
});
const require = createRequire(join(tools, "package.json"));
for (const [name, version] of [
  ["esbuild", "0.28.2"],
  ["@anthropic-ai/mcpb", "2.1.2"],
]) {
  const metadata = JSON.parse(
    await readFile(join(tools, "node_modules", name, "package.json"), "utf8"),
  );
  assert.equal(metadata.version, version);
}
const { build } = require("esbuild");
await mkdir(join(output, "bundle", "server"), { recursive: true });
const bundle = join(output, "bundle");
const built = await build({
  absWorkingDir: source,
  entryPoints: ["apps/mcp/src/main.ts"],
  outfile: join(bundle, "server", "main.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  metafile: true,
  sourcemap: false,
  legalComments: "external",
  banner: {
    js: "import { createRequire as __creatorcutRequire } from 'node:module'; const require = __creatorcutRequire(import.meta.url);",
  },
});
const manifest = {
  manifest_version: "0.3",
  name: "creatorcut-mcp",
  display_name: "CreatorCut by AgentMesh360",
  version: VERSION,
  description: "Local video post-production tools for CreatorCut projects.",
  long_description:
    "Inspect local talking-head and product-recording projects, transcribe, preview signed edits, undo/redo and export. Media stays local. Remote Director planning requires separate CreatorCut onboarding, trusted configuration and explicit context consent. Director planning uses AgentMesh360 credits. This bundle does not install FFmpeg or whisper.cpp and does not upgrade an existing CreatorCut installation.",
  author: { name: "AgentMesh360", url: "https://agentmesh360.com/" },
  repository: {
    type: "git",
    url: "https://github.com/jiyangnan/AgentMesh-CreatorCut",
  },
  homepage: "https://creatorcut.agentmesh360.com/",
  documentation:
    "https://github.com/jiyangnan/AgentMesh-CreatorCut/blob/main/docs/mcp-distribution.md",
  support: "https://github.com/jiyangnan/AgentMesh-CreatorCut/issues",
  license: "Apache-2.0",
  privacy_policies: [
    "https://github.com/jiyangnan/AgentMesh-CreatorCut/blob/main/docs/privacy.md",
  ],
  server: {
    type: "node",
    entry_point: "server/main.mjs",
    mcp_config: {
      command: "node",
      args: [
        "${__dirname}/server/main.mjs",
        "--project",
        "${user_config.project_directory}",
      ],
    },
  },
  compatibility: { runtimes: { node: ">=24 <25" } },
  user_config: {
    project_directory: {
      type: "directory",
      title: "CreatorCut project directory",
      description: "An existing CreatorCut v0.2.1 project directory.",
      required: true,
    },
  },
  tools_generated: true,
};
await writeFile(
  join(bundle, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
await writeFile(
  join(bundle, "package.json"),
  JSON.stringify({ private: true, type: "module" }) + "\n",
);
await copyFile(join(source, "LICENSE"), join(bundle, "LICENSE"));

const dependencies = new Map();
for (const input of Object.keys(built.metafile.inputs)) {
  if (!input.includes("node_modules/")) continue;
  let directory = dirname(join(source, input));
  while (directory.startsWith(source)) {
    try {
      const pkg = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      );
      if (pkg.name && pkg.version) {
        const key = `${pkg.name}@${pkg.version}`;
        if (!dependencies.has(key)) {
          let licenseText = "";
          for (const filename of [
            "LICENSE",
            "LICENSE.md",
            "LICENSE.txt",
            "license",
            "license.md",
          ]) {
            try {
              licenseText = await readFile(join(directory, filename), "utf8");
              break;
            } catch {}
          }
          dependencies.set(key, {
            license: pkg.license ?? "unknown",
            text: licenseText,
          });
        }
        break;
      }
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}
await writeFile(
  join(bundle, "THIRD-PARTY-NOTICES.txt"),
  [...dependencies.entries()]
    .sort()
    .map(([name, data]) => `${name} (${data.license})\n${data.text}\n`)
    .join("\n"),
);
const provenance = {
  product: "creatorcut",
  version: VERSION,
  source_commit: SOURCE_COMMIT,
  source_archive_sha256: SOURCE_SHA256,
  build_tools: {
    esbuild: "0.28.2",
    mcpb: "2.1.2",
    node: process.versions.node,
  },
  dependency_licenses: Object.fromEntries(
    [...dependencies].map(([name, data]) => [name, data.license]),
  ),
};
await writeFile(
  join(bundle, "SOURCE.json"),
  JSON.stringify(provenance, null, 2) + "\n",
);
const artifactName = `creatorcut-mcp-v${VERSION}.mcpb`;
const artifact = join(output, artifactName);
execFileSync(
  "python3",
  [
    "-c",
    `import pathlib, sys, zipfile
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
 for p in sorted(root.rglob('*')):
  if p.is_symlink(): raise ValueError('Symlink in bundle')
  if p.is_file():
   i=zipfile.ZipInfo(p.relative_to(root).as_posix(),date_time=(2026,7,29,0,0,0))
   i.compress_type=zipfile.ZIP_DEFLATED
   i.external_attr=0o100644 << 16
   z.writestr(i,p.read_bytes(),compresslevel=9)
`,
    bundle,
    artifact,
  ],
  { stdio: "inherit" },
);
const sha256 = createHash("sha256")
  .update(await readFile(artifact))
  .digest("hex");
const server = {
  $schema:
    "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: NAME,
  title: "CreatorCut by AgentMesh360",
  description:
    "Local video post-production: project inspection, transcription, signed edits and export.",
  version: VERSION,
  websiteUrl: "https://creatorcut.agentmesh360.com/",
  repository: {
    url: "https://github.com/jiyangnan/AgentMesh-CreatorCut",
    source: "github",
  },
  packages: [
    {
      registryType: "mcpb",
      identifier: `https://github.com/jiyangnan/AgentMesh-CreatorCut/releases/download/mcp-v${VERSION}/${artifactName}`,
      fileSha256: sha256,
      transport: { type: "stdio" },
    },
  ],
};
await writeFile(
  join(output, "server.json"),
  JSON.stringify(server, null, 2) + "\n",
);
await writeFile(join(output, "SHA256SUMS"), `${sha256}  ${artifactName}\n`);
await copyFile(join(bundle, "SOURCE.json"), join(output, "SOURCE.json"));
console.log(
  JSON.stringify({
    artifact,
    sha256,
    source_commit: SOURCE_COMMIT,
    metadata: join(output, "server.json"),
  }),
);
