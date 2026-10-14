# CreatorCut MCP distribution

CreatorCut provides a project-scoped local MCP server. Its stdio transport does
not require a separately hosted MCP service. The MCP bundle contains the
existing public client code and its JavaScript dependencies.

## Release boundary

The first bundle uses the exact Core-approved `v0.2.1` source archive:

- commit: `4305b1e201f602fb769ae4973c2b37efbf62e923`;
- archive SHA-256:
  `21b10149fa720f753e3f90371c399ed13c01227b5481dd013845bcee200972b5`;
- distribution tag: `mcp-v0.2.1`;
- registry name: `io.github.jiyangnan/creatorcut`.

The [official registry entry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.jiyangnan%2Fcreatorcut/versions/latest)
was verified as active on 2026-10-14. The returned distribution version,
repository, download URL, checksum and transport match this release.

The MCP distribution version identifies the bundle. The server's existing
initialize response reports `0.2.0`. Installing the bundle does not change the
managed client version policy or upgrade an existing installation.

## Install and connect

Download the `.mcpb` asset and `SHA256SUMS` from the MCP distribution release.
Verify the file's SHA-256 before opening it in a host that supports MCPB.
Select an existing CreatorCut **v0.2.1** project directory. The bundle requires
Node.js 24; a host's bundled Node version must meet that requirement.
Use the same client version for a project: this bundle is not for projects
adopted by v0.3.0, and different client versions must not open the same project
concurrently.

For a generic stdio MCP host, extract the verified bundle to a dedicated
directory and configure it with your Node.js 24 executable:

```json
{
  "mcpServers": {
    "creatorcut": {
      "command": "/absolute/path/to/node24",
      "args": [
        "/absolute/path/to/extracted-bundle/server/main.mjs",
        "--project",
        "/absolute/path/to/your-creatorcut-project"
      ]
    }
  }
}
```

Start with `creatorcut_project_status`. The MCP interface also exposes local
context inspection, transcription, signed-edit preview/apply, undo/redo and
resumable export. Media execution needs the same FFmpeg and whisper.cpp
prerequisites as the managed client; this bundle does not install them.

Remote Director tools retain the existing secure credential, trusted keyset
and explicit context-consent requirements. Use the managed CreatorCut CLI's
onboarding to configure those prerequisites. Director planning uses
AgentMesh360 credits; inspection and listing tools do not start a paid plan.
Native host UI support is subject to the existing supported-host matrix in
[agent onboarding](agent-onboarding.md). MCPB format validation alone does not
establish new host support.

## Rebuild the bundle

Use Node.js 24.18.0, pnpm 10.30.3 and Python 3. Extract the exact approved source
archive to a clean temporary directory, then install its locked dependencies.
Install the build-only tools outside the source checkout:

```sh
npm install --prefix /tmp/creatorcut-mcp-tools --ignore-scripts --no-audit --no-fund esbuild@0.28.2 @anthropic-ai/mcpb@2.1.2
cd /tmp/creatorcut-source
pnpm install --frozen-lockfile --ignore-scripts
cd /path/to/AgentMesh-CreatorCut
node scripts/package-mcp-bundle.mjs \
  --source /tmp/creatorcut-source \
  --archive /tmp/AgentMesh-CreatorCut-v0.2.1.tar \
  --tools /tmp/creatorcut-mcp-tools \
  --output /tmp/creatorcut-mcp-output
```

The script checks the approved archive digest and source files, builds the MCP
dependency closure, bundles the runtime, includes license notices and writes
a deterministic archive plus registry metadata. Keep build output outside the
repository. Before publication, validate the manifest and metadata, then run
the clean-directory stdio smoke against the extracted archive.

## Publication and verification

Publish the bundle under `mcp-v0.2.1` with `latest=false`. Preserve existing
product tags, archives and signed Core policy. Register the generated
`server.json` using the official `mcp-publisher` tool. Verify the public package
download, its checksum and the returned registry entry independently.

Registry publication, downstream directory listings, installation/downloads
and AI citations are separate observations. Submission alone establishes none
of the later outcomes. See the official [registry package types](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/package-types.mdx)
and [MCPB specification](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md).
