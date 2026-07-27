# Cycle 3 / Batch 2: local media execution

Date: 2026-07-27

Status: local implementation checkpoint recorded; real Server-to-client signed
operation contract remains unverified and Cycle 3 remains in progress.

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
  proxy generation, executor branches for all public Protocol v1 operations,
  revision-bound preview/apply, and resumable FFmpeg export. Batch 2 did not
  establish a strict per-operation parameter schema or a 13-operation
  deterministic apply/fail-closed test matrix.
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

- Node 24 formatting, typecheck, build, public boundary checks, 27 Vitest cases
  and 3 Node contract tests passed. This count did not include a real
  Server-generated signed Manifest or real four-host smoke.
- A synthetic two-second source completed real FFmpeg import, proxy generation
  and export. ffprobe confirmed H.264 video, AAC audio and a two-second MP4.
- A real 12-second mixed-language product recording completed verified import
  and local three-candidate whisper.cpp transcription in approximately
  17 seconds. The task persisted all six recovery steps and a stable transcript.
- Source media, prepared audio and the local model remained on the machine.
- Protocol bundle digest remained
  `sha256:951723362bd171ad35a2194d2aa284b470db25f766bd46598b23268c9fbef59d`.

## Act

- Treat local media/transcription and Manifest execution only as a Batch 2 local
  implementation checkpoint. The signed artifact used here was not generated
  by the real `creatorcut-server` policy/finalize/signing path.
- Keep Cycle 3 open. Its only closeout Batch 3 first freezes and implements the
  operations parameter contract, `*_ref` resolution, a real Server-generated
  `remove_range` fixture and named safety/recovery tests; it then completes the
  Codex MCP App, public Claude Code/OpenClaw Skills, generic fallback and real
  cross-host interruption-recovery smoke.
- Do not begin Cycle 4 installation/release governance, push, tag, deploy or
  production canary based on this checkpoint.
