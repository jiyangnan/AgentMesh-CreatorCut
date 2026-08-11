# AgentMesh-CreatorCut

AgentMesh-CreatorCut is the public execution product for CreatorCut: an Agent
for intelligent post-production of talking-head videos and product screen
recordings.

M1 is designed for Chinese, English, and mixed-language recordings. The public
client keeps media processing local, renders Director-driven interactive
cards across hosts, verifies signed edit plans, previews changes, and applies
only declarative reversible operations.

## Install

macOS or Ubuntu:

```bash
curl -fsSL https://raw.githubusercontent.com/jiyangnan/AgentMesh-CreatorCut/main/scripts/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/jiyangnan/AgentMesh-CreatorCut/main/scripts/install.ps1 | iex
```

The installers set up the pinned Node runtime, Git, FFmpeg, whisper.cpp,
multilingual transcription model, secure credential backend, CLI shim, and
signed managed-update channel. A successful install immediately starts the
guided Agent handoff:

```bash
creatorcut onboard
```

`onboard` checks the local toolchain and trusted Director configuration, asks
for the AgentMesh API key through secure standard input, guides local recording
import, starts multilingual transcription, and then returns the exact
next action. Agents starting another process must invoke the exact
`next_process.executable` with `next_process.argv`, `next_process.cwd`,
`shell: false`, and the allowlisted `env_overrides` merged into the host
environment. Embedded API hosts may pass `next_argv` directly back to
`executeCli`.
OpenClaw must instead pass the exact `next_openclaw.exec` object to its exec
tool. That object always uses the fixed literal command
`creatorcut __openclaw-bridge`; argv is carried only in the tool's structured
environment field. For the two non-secret JSON-input steps, follow the returned
PTY `json-line-v1` contract. API keys never use the bridge and remain a manual,
private-terminal input.
After that private login, OpenClaw changes only `auth login` to `auth status`
in the retained non-secret continuation; the returned continuation restores
the same project-scoped `onboard` flow and explicit local dependency
overrides.
The OpenClaw Skill and CreatorCut CLI must be installed from the same verified
release archive. A mismatched older Skill fails closed before project access;
until the matching Skill reaches ClawHub, reinstall it from the RC archive.
`next_suggested` is display-only and uses placeholders when user input is still
required. Run the same command at any time to resume from the first incomplete
stage.

When a project was created by v0.2.1, v0.3.0 requires a one-time, explicit
metadata adoption before status or mutation commands:

```bash
creatorcut project adopt-public \
  --project /path/to/project.creatorcut \
  --confirm-local
```

This verifies the existing public history and writes only local authority
metadata. It does not invoke the experimental internal-project migration.
`--confirm-local` also confirms that every v0.2.1 CreatorCut process has exited
and that no legacy preview, Director request, export, or transcription task is
still in progress. Do not open the project concurrently in v0.2.1 after
adoption. Completed legacy generated assets, previews, and transcription work
remain byte-for-byte in place and outside metadata backup, digest, and rollback
deletion. Windows v0.2.1 generated-asset paths are validated without rewriting
their stored bytes; moving such a project to a POSIX host before adoption is
not a supported path-translation workflow.
The project state must be on a local filesystem with same-volume atomic rename
and reliable SQLite/OS file locking; FAT/exFAT, network shares, and
cloud-synchronized virtual filesystems are not supported project locations in
v0.3.

See [supported platforms](docs/SUPPORTED-PLATFORMS.md) for the exact macOS,
Ubuntu, Windows, architecture, and dependency contract.

## Current status

AgentMesh-CreatorCut M1 Cycle 1–5 is complete and public stable releases are
available through the signed managed-install channel. The exact activated
version and artifact are recorded by the signed AgentMesh Core policy and
`release/production-smoke-lock.json`. Production cloud
admission is open for the Director main feature at the AgentMesh Core
authoritative price of 50 credits. This repository contains the
frozen public Protocol v1 plus a
source-buildable local runtime, Director verification code, cross-platform
secure credential adapters, stable JSON CLI, public MCP server, semantic card/text
presentation adapters, local media import, Chinese/English/mixed whisper.cpp
transcription, local Manifest preview/apply/undo/redo, and resumable export.

v0.3.0 adds digest/generation-bound public mutation recovery and verified
v0.2.1 public-project adoption. Internal-project migration and rollback remain
disabled until their native packaging, installation, platform, and recovery
gates are complete.

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

Cycle 4 added the managed installer and signed release chain. Cycle 5 completed
the real GitHub RC/stable tag and canonical archive, staging signed Manifest,
original-color three-material dogfood, production dark deployment, approved
50-credit paid canary/rollback, persistent Core stable ReleaseManifest and a
formal clean public-channel reinstall with real Server/Core preflight.

The public repository is the release carrier, while availability, admission,
and the authoritative 50-credit Director price remain controlled by
AgentMesh Core.

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
`creatorcut auth login` in macOS Keychain, Windows DPAPI, or Linux Secret
Service; a trusted recovery-root-signed Director keyset; an
explicit endpoint, and the pinned protocol bundle digest. The official managed
installer provisions the pinned public production trust bundle. A source build
does not ship credentials, silently select staging, or bypass that trust
configuration.

See [Agent onboarding](docs/agent-onboarding.md),
[privacy contract](docs/privacy.md), and
[managed release policy](docs/release-policy.md). Exact Cycle 4 scope and
verification are recorded in
[Cycle 4 closeout evidence](docs/operations/2026-07-27-cycle4-managed-release-closeout.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
