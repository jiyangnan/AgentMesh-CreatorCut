# Changelog

## 0.3.0

- Add generation- and digest-bound public storage authority, durable mutation
  recovery, and explicit byte-preserving adoption for v0.2.1 public projects.
- Make guided setup and agent continuations preserve project scope, cwd, and
  non-secret local dependency overrides without shell interpolation.
- Make `doctor` discover local tools consistently with runtime execution,
  honor explicit CLI paths, and fail closed for empty or missing dependency
  option values before credential, project, adapter, or media side effects.
- Keep stable JSON output clean by filtering only Node's expected
  `node:sqlite` experimental warning while preserving unrelated warnings.
- Keep internal-project migration and rollback disabled; this release does not
  widen the supported platform matrix or the cooperative same-user threat
  model.

## 0.3.0-rc.3

- Make `doctor` and `onboard` honor explicit `--ffmpeg`, `--ffprobe`,
  `--whisper`, and `--model` paths instead of silently discarding them.
- Preserve those non-secret dependency overrides through every structured
  onboarding continuation, including the private-terminal authentication
  handoff and the resumed OpenClaw `auth status` flow.
- Treat an explicitly empty executable configuration as invalid instead of
  falling back to `PATH`, and reject missing dependency-option values before
  credential, project, adapter, or media side effects.

## 0.3.0-rc.2

- Make `creatorcut --version` return the same stable JSON envelope as
  `creatorcut version`.
- Make `doctor` discover FFmpeg, FFprobe, and whisper.cpp from `PATH` when no
  managed path is configured, while preserving fail-closed precedence for an
  invalid explicit configuration.
- Stop advertising a transcription command that must fail when any required
  local transcription dependency is unavailable; return an explicit
  user-action checkpoint instead.
- Preserve project scope in follow-up commands through structured `next_argv`
  and cross-platform `next_process` fields, including the original cwd and a
  non-secret managed-environment allowlist. This avoids shell interpolation of
  local project paths or reliance on Windows command shims.
- Add an exact `next_openclaw` continuation for the supported OpenClaw host.
  Its shell command is a fixed literal, argv stays in a bounded structured-env
  request, non-secret JSON input uses a no-echo PTY line, and API keys are
  refused by the bridge. Mixed CLI/Skill versions fail closed before project
  access; install the matching Skill from the same verified RC archive until
  ClawHub distribution is activated. Private-terminal authentication resumes
  through a structured, project-scoped `auth status` continuation.
- Keep CLI stderr clean by filtering only Node's known `node:sqlite`
  experimental warning while preserving all other process warnings.

## 0.3.0-rc.1

- Add generation- and digest-bound public storage authority plus a durable
  mutation journal for local runtime, Director, media, transcription, CLI, and
  MCP writes.
- Preserve existing v0.2.1 public projects through an explicit, metadata-only
  `project adopt-public --confirm-local` flow, including strict verification of
  legacy commit, undo, and redo history.
- Keep internal-project migration and rollback disabled until the production
  native whole-tree swap, immutable installer, platform, and recovery gates are
  complete.
- Clean generated package output before every release build so managed updates
  cannot retain stale code from an older checkout.

## 0.2.1

- Add resumable `creatorcut onboard` guidance from dependency checks through
  secure login, local media import, multilingual transcription, explicit
  context consent, and Director start.
- Pin and verify the public production Director trust bundle in the macOS,
  Ubuntu, and Windows managed installers.
- Place a macOS-style one-command terminal directly beside the website's
  install call to action and document the complete post-install journey.

## 0.2.0

- Add one-command managed installation for macOS 14+, Ubuntu 22.04/24.04, and
  Windows 10 22H2/11.
- Install pinned Node.js 24, pnpm 10, FFmpeg/FFprobe, whisper.cpp, and the
  verified multilingual Whisper base model without manual path discovery.
- Add platform-native API-key storage through macOS Keychain, Windows
  current-user DPAPI, and Linux Secret Service.
- Extend signed managed updates and rollback to all supported GA platforms.
- Add macOS, Ubuntu, and Windows verification in GitHub Actions.
- Add the bilingual AgentMesh-CreatorCut product website and enforce its
  local-media, paid-Director boundary as a tested public contract.

Protocol v1 and existing `.creatorcut` projects remain compatible.

## 0.1.0

- Freeze public CreatorCut Protocol v1 contracts.
- Add strict canonical JSON, Ed25519 envelope/keyset verification, resource
  limits, and declarative-operation safety validation.
- Establish the public/private/control-plane system boundary.
- Add the Cycle 3 / Batch 1 public runtime, macOS Keychain credential adapter,
  verified Director client, stable JSON CLI, stdio MCP server, and cross-host
  semantic card/text presentation.
- Add exact DirectorContext inspection and revision/digest-bound project
  consent without uploading original media or local paths.
- Add the Cycle 3 / Batch 2 local media pipeline: verified import and proxy
  generation, Chinese/English/mixed local whisper.cpp transcription, immutable
  project snapshots, deterministic Manifest execution, preview-bound apply,
  monotonic undo/redo, and resumable export.
- Add matching stable CLI and public MCP tools for transcription, local edit
  execution, and export task recovery.
