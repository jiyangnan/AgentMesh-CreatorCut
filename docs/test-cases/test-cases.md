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
- [x] Codex, Claude Code, OpenClaw and generic text capability profiles are
      represented independently from Server card ordering and defaults.
- [ ] Real Codex, Claude Code, OpenClaw and generic text hosts have not yet
      consumed one signed fixture and produced the fixed expected AnswerSet
      digest; that is a Cycle 3 / Batch 3 gate.

## TC-PUBLIC-DIRECTOR-001: verified public Director client

- [x] Non-loopback plaintext endpoints are rejected.
- [x] Preflight is content-free and does not authenticate or upload transcript.
- [x] Director keyset must be recovery-root signed, current, unexpired and above
      the configured version floor.
- [x] Session, quote, ReviewPlan and Manifest verification binds project,
      revision, planning input, transcript, timeline, EditBrief, capabilities,
      sequence, previous digest and stable identifiers.
- [ ] Response-loss retry must prove reuse of the locally persisted
      `generation_id`; the implementation exists but has no named test yet.

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
      revisions in the currently tested path.
- [ ] The stale-process/PID lock recovery implementation requires a named
      automatic test.
- [x] The Batch 2 recorded manual smoke rejected existing project destinations,
      project asset path escape, realpath symlink escape and
      export-to-project-asset collisions.
- [ ] Named automatic tests must reproduce the media-engine/runtime path and
      symlink failures from that recorded smoke.

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

- [x] The local executor contains branches for every Protocol v1 declarative
      operation and validates common preconditions.
- [ ] Per-operation strict parameter schemas and deterministic
      apply/fail-closed tests exist only for a subset; all 13 advertised
      operations require named coverage in Cycle 3 / Batch 3.
- [x] Preview renders locally and records Manifest, planned-timeline and preview
      digests plus a single exact confirmation token.
- [x] Apply rejects a missing/stale confirmation token and commits one new
      revision on the tested success path.
- [ ] Named tests must cover on-disk preview SHA-256 tampering, changed
      revision/signed Manifest and unconfirmed export overwrite.
- [x] Export start/status/resume/cancel persist state, preserve original audio by
      default, render through shell-free FFmpeg invocation and verify the output.
- [x] A real local FFmpeg import/proxy/export smoke produced a valid MP4 with
      both H.264 video and AAC audio.

## TC-PUBLIC-SERVER-FIXTURE-001: real Server signed Manifest

- [ ] Generate a deterministic `remove_range` Manifest through the real
      `creatorcut-server` policy/finalize/signing code path using test-only keys.
- [ ] Verify, preview and apply that fixture in this repository without a Server
      source checkout.
- [ ] Preserve the signed `track_ref`, `clip_ref` and `source_asset_ref`
      vocabulary; resolve them deterministically from the Manifest
      `base_revision` snapshot.
- [ ] Reject unresolved, ambiguous or stale refs and any keyset, envelope chain,
      revision, input or identifier tampering.

## TC-PUBLIC-OPERATIONS-001: operations v1 contract

- [x] Pin one `creatorcut-operations/1.0` adjunct contract digest in the public
      client and private Server while preserving the existing Protocol v1
      bundle digest.
- [ ] Give all 13 advertised operations strict parameter/precondition schemas,
      one deterministic apply golden case and at least one fail-closed case.
- [ ] Remove any operation from advertised capabilities if the execution
      contract cannot be completed in M1.

## TC-PUBLIC-DIRECTOR-002: chain and recovery

- [ ] Directly test recovery-root keyset, sequence/previous-envelope digest,
      artifact/identifier/input binding and response-loss Generation recovery.
- [ ] A lost create response reuses the persisted `generation_id` and does not
      create a second paid task.

## TC-PUBLIC-PATH-REVISION-001: transcription safety

- [ ] Transcription source resolution enforces canonical/realpath project
      boundaries and rejects symlink escape.
- [ ] Transcription resume rejects task/project `base_revision` drift in the
      same way as export resume.

## TC-PUBLIC-HOST-001: four-host fixed fixture

- [ ] Codex, Claude Code, OpenClaw and generic text consume one signed card
      fixture with identical card, option and presentation digests.
- [ ] Every host result equals the fixture's fixed expected AnswerSet digest.
- [ ] Director session, Generation, preview and export interruption points
      recover without duplicate Generation, apply or output overwrite.

## Cycle 3 closeout gate

Complete the operations/ref/real-Server fixture gates first, then build the
Codex MCP App UI and public Skills and run the real four-host recovery matrix.
Cycle 3 remains in progress; Batch 3 is its only closeout batch.
