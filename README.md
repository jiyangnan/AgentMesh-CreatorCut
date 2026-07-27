# AgentMesh-CreatorCut

AgentMesh-CreatorCut is the public execution product for CreatorCut: an Agent
for intelligent post-production of talking-head videos and product screen
recordings.

M1 is designed for Chinese, English, and mixed-language recordings. The public
client will keep media processing local, render Director-driven interactive
cards across hosts, verify signed edit plans, preview changes, and apply only
declarative reversible operations.

## Current status

This repository has recorded the CreatorCut Cycle 3 / Batch 3 code checkpoint.
It contains the frozen public Protocol v1 plus a
source-buildable local runtime, Director verification code, macOS Keychain
credential adapter, stable JSON CLI, public MCP server, semantic card/text
presentation adapters, local media import, Chinese/English/mixed whisper.cpp
transcription, local Manifest preview/apply/undo/redo, and resumable export.

Batch 3 now includes the independent `creatorcut-operations/1.0` contract,
immutable `*_ref` resolution, a real Server-generated signed `remove_range`
fixture, the complete advertised-operation test matrix, Codex MCP App code,
the public OpenClaw Skill, generic-text fixture submission, and named
session/Generation/preview/export recovery tests.

Cycle 3 is closed for the M1 support matrix: the real Codex native presentation
and submit gate, the real OpenClaw Skill run, generic-text fallback, and the
four-point recovery matrix passed with one fixed fixture and AnswerSet digest.
Claude Code is deferred to a post-M1 compatibility iteration and is not an M1
supported or release-tested host. Its source preview remains under
`skills/claude-code` but is excluded from support claims.

This is still a development checkpoint. Managed installation, remote release
metadata and full public-product dogfood remain unfinished. There is no public
release, tag, installation command, or production Director endpoint yet.

## Product boundary

```text
AgentMesh-CreatorCut (public, local execution)
  -> creatorcut-server (private Director strategy)
  -> agentmesh-core (identity, entitlements, price and credits)
```

`CreatorCut` is the internal Studio/dogfood source. `creatorcut-server` owns card
orchestration, semantic editing policy, signed plan generation, and billing
recovery. `agentmesh-core` remains the shared control plane and price source.
This product does not depend on `AgentMesh360-Client`.

See [System boundary](docs/CREATORCUT-SYSTEM-BOUNDARY.md) for the data and trust
model.

## Development

Requirements:

- Node 24
- pnpm 10

```bash
pnpm install
pnpm verify
pnpm protocol:digest
pnpm pack:protocol
```

`pnpm protocol:digest` prints the stable digest that private consumers must pin.
`pnpm pack:protocol` builds the independently consumable protocol tarball used
by private services during this pre-release phase.

After a source build, the development CLI can be invoked with Node 24:

```bash
node apps/cli/dist/src/main.js doctor
```

The local-only media path is available for development verification:

```bash
node apps/cli/dist/src/main.js media import \
  --project /path/to/demo.creatorcut \
  --source /path/to/recording.mov

node apps/cli/dist/src/main.js transcribe start \
  --project /path/to/demo.creatorcut \
  --model /path/to/ggml-model.bin \
  --language mixed

node apps/cli/dist/src/main.js export start \
  --project /path/to/demo.creatorcut \
  --output /path/to/demo.mp4
```

`zh`, `en`, `auto`, and `mixed` transcription modes are supported. The
`mixed` mode runs local `auto`, Chinese, and English candidates and selects the
best bilingual result. Local editing keeps original audio unless a signed
Manifest explicitly requests a supported change. Applying a signed Manifest
requires the exact confirmation token returned by `edit preview`; exporting
never overwrites an existing file unless `--confirm-overwrite` is present.

Remote Director commands intentionally require an AgentMesh API key stored by
`creatorcut auth login`, a trusted recovery-root-signed Director keyset, an
explicit endpoint, and the pinned protocol bundle digest. The repository does
not ship staging credentials or silently select a production endpoint.

See [Agent onboarding](docs/agent-onboarding.md),
[privacy contract](docs/privacy.md), and
[Cycle 3 D recovery evidence](docs/operations/2026-07-27-cycle3-d-recovery-code-evidence.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
