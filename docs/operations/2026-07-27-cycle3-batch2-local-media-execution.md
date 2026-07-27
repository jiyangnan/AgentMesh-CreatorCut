# Cycle 3 / Batch 2: local media execution

Date: 2026-07-27

Status: local implementation checkpoint complete; Cycle 3 remains in progress.

## Plan

Complete the next frozen Cycle 3 user-chain segment without adding a new Cycle:

1. Import local talking-head or product-screen recordings into a recoverable
   `.creatorcut` project.
2. Transcribe Chinese, English or mixed speech locally.
3. Re-verify a signed Director Manifest at execution time, render a local
   preview, require exact preview confirmation, and preserve reversible history.
4. Export a verified local MP4 while keeping original audio by default.

The public repository may execute declarative operations, but it may not contain
Director policy, card orchestration, prompts, semantic thresholds, billing
strategy, Service Tokens or signing private keys.

## Do

- Extended the public runtime with local project creation, media metadata,
  timeline tracks, immutable snapshots, monotonic undo/redo history, task state
  and a stale-process-recoverable project lock.
- Added a local media engine for streaming source verification, ffprobe,
  proxy generation, all public Protocol v1 operations, revision-bound preview
  and apply, and resumable FFmpeg export.
- Added a local whisper.cpp adapter with `zh`, `en`, `auto` and `mixed` modes.
  Mixed mode runs and checkpoints three candidates before selecting the best
  bilingual result.
- Extended the verified Director client so preview/apply always re-read and
  re-verify the stored envelope, keyset, chain, project revision and all signed
  digests.
- Added stable CLI and public MCP operations for transcription, preview/apply,
  undo/redo and export. Destructive operations retain explicit confirmation
  annotations.

## Check

- Node 24 formatting, typecheck, build, public boundary checks and 30 automated
  tests passed.
- A synthetic two-second source completed real FFmpeg import, proxy generation
  and export. ffprobe confirmed H.264 video, AAC audio and a two-second MP4.
- A real 12-second mixed-language product recording completed verified import
  and local three-candidate whisper.cpp transcription in approximately
  17 seconds. The task persisted all six recovery steps and a stable transcript.
- Source media, prepared audio and the local model remained on the machine.
- Protocol bundle digest remained
  `sha256:951723362bd171ad35a2194d2aa284b470db25f766bd46598b23268c9fbef59d`.

## Act

- Treat local media/transcription and signed-Manifest execution as completed
  Cycle 3 / Batch 2 capability.
- Keep Cycle 3 open. The next fixed batch is the Codex MCP App UI, public
  Claude Code/OpenClaw Skills, generic fallback and real cross-host
  interruption-recovery smoke.
- Do not begin Cycle 4 installation/release governance, push, tag, deploy or
  production canary based on this checkpoint.
