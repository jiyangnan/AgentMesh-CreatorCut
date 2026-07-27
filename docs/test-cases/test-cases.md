# AgentMesh-CreatorCut test cases

## TC-PROTO-001: canonical signatures

- [x] JCS is stable and rejects non-JSON or ambiguous inputs.
- [x] Director envelopes reject tampering, expiration, revoked keys, and keyset rollback.
- [x] Artifact-specific identity fields cannot be mixed.

## TC-PROTO-002: safe public operations

- [x] Manifests are revision- and digest-bound.
- [x] Operations are declarative and reject scripts, commands, and arbitrary paths.
- [x] Resource limits cover context, transcript, visual summaries, cards, review segments, and operations.

## TC-PROTO-003: deployable planning contract

- [x] Compiled ESM, declarations and JSON Schema can be consumed without a source checkout.
- [x] DirectorContext contains opaque media/timeline mappings, local silence facts and actual capabilities without media bytes or paths.
- [x] Structured fact digests, ranges, counts, versions and unique IDs are validated.
- [x] AnswerSet binds card/presentation/capabilities/envelope/revision state.
- [x] ReviewDecisionSet binds Generation and ReviewPlan and validates modified ranges.

## TC-REPO-001: public repository boundary

- [x] Protocol bundle hashing is deterministic.
- [x] Public files contain no internal checkout path, planner/policy package path, Service Token marker, or internal media-directory reference.
- [x] README states incomplete product/release status instead of advertising unavailable commands.

## TC-PUBLIC-007: CLI auth and stable output

- [x] CLI returns `creatorcut-cli/1.0` JSON with stable success/error,
      `requires_user_action`, `retryable`, and `next_suggested` fields.
- [x] macOS Keychain write sends the AgentMesh API key on stdin and never puts
      it in argv.
- [x] `--key` is rejected and the attempted secret is absent from output.
- [x] `auth logout` removes only the local Keychain item and explicitly reports
      that the remote Core API key was not revoked.

## TC-PUBLIC-PRIVACY-001: context inspection and consent

- [x] Current `.creatorcut` project, timeline, transcript and approved EditBrief
      produce a schema-validated DirectorContext.
- [x] Context contains Chinese, English or mixed transcript text and timing but
      no original media bytes, screenshots, local relative/absolute paths or
      usernames.
- [x] Consent is mode `0600`, contains no transcript text, and binds exact
      project ID, revision, planning digest, transcript digest and consent
      version.
- [x] Any context or revision change invalidates the previous consent.

## TC-PUBLIC-008: cross-host cards

- [x] Native option IDs and numbered text tokens normalize to identical stable
      answer semantics.
- [x] Stale presentation digest, duplicate card, unknown option and missing
      required answer fail closed.
- [x] Codex, Claude Code, OpenClaw and generic text capabilities are represented
      independently from Server card ordering and defaults.

## TC-PUBLIC-DIRECTOR-001: verified public Director client

- [x] Non-loopback plaintext endpoints are rejected.
- [x] Preflight is content-free and does not authenticate or upload transcript.
- [x] Director keyset must be recovery-root signed, current, unexpired and above
      the configured version floor.
- [x] Session, quote, ReviewPlan and Manifest verification binds project,
      revision, planning input, transcript, timeline, EditBrief, capabilities,
      sequence, previous digest and stable identifiers.
- [x] Generation retry reuses the locally persisted `generation_id`.

## TC-PUBLIC-MCP-001: public runtime boundary

- [x] MCP project/context tools work locally without a Director connection.
- [x] MCP imports only public runtime, Director client and host adapters; it
      does not import Studio or local strategy packages.
- [x] MCP card tools return complete structured presentation plus equivalent
      text fallback.

## TC-PUBLIC-MEDIA-001: local media import and project history

- [x] Import streams SHA-256, verifies the copied source, probes rotation-aware
      metadata and creates a local H.264 proxy without changing original audio.
- [x] Project snapshots are immutable; apply, undo and redo create monotonic
      revisions under a stale-process-recoverable project lock.
- [x] Existing project destinations, project asset path escape, realpath
      symlink escape and export-to-project-asset collisions fail closed.

## TC-PUBLIC-ASR-001: local bilingual transcription and recovery

- [x] `zh`, `en`, `auto` and `mixed` modes map whisper.cpp JSON into stable
      Chinese/English token timing and recover split UTF-8 tokens.
- [x] Mixed mode persists `auto`, Chinese and English candidates and chooses by
      bilingual coverage/confidence.
- [x] Transcription start/status/resume/cancel persist local checkpoints and use
      CPU fallback after a failed GPU attempt.
- [x] A real 12-second mixed-language product recording completed local import,
      three-candidate transcription and transcript persistence in approximately
      17 seconds with a locally installed small model.

## TC-PUBLIC-EXEC-001: signed Manifest preview, apply and export

- [x] Every Protocol v1 declarative operation is validated against its
      preconditions and applied deterministically to a planned timeline.
- [x] Preview renders locally and records Manifest, planned-timeline and preview
      digests plus a single exact confirmation token.
- [x] Apply rejects a missing/stale token, modified preview, changed revision or
      changed signed Manifest, then commits one new revision on success.
- [x] Export start/status/resume/cancel persist state, preserve original audio by
      default, render through shell-free FFmpeg invocation and verify the output.
- [x] A real local FFmpeg import/proxy/export smoke produced a valid MP4 with
      both H.264 video and AAC audio.

## Next Cycle 3 gate

Build the Codex MCP App UI and public Skills, then run Codex, Claude Code,
OpenClaw and generic text interruption-recovery smoke against one signed
semantic fixture. Cycle 3 remains in progress.
