# Changelog

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
