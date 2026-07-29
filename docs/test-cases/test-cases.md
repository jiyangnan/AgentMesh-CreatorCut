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
- [x] `creatorcut onboard` resumes at the first incomplete stage: environment
      repair, secure authentication, local media import, transcription,
      explicit Director-context consent, or Director start.
- [x] `doctor` and `auth login` return to `onboard` instead of suggesting a
      project-dependent action before a project exists.
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
- [x] The M1 supported host matrix—real Codex, real OpenClaw and generic
      text—consumed one signed fixture and produced the fixed expected
      AnswerSet digest.
- [x] Claude Code remains an independently represented experimental capability
      profile, but real-host support is deferred beyond M1.

## TC-PUBLIC-DIRECTOR-001: verified public Director client

- [x] Non-loopback plaintext endpoints are rejected.
- [x] Preflight is content-free and does not authenticate or upload transcript.
- [x] Director keyset must be recovery-root signed, current, unexpired and above
      the configured version floor.
- [x] Session, quote, ReviewPlan and Manifest verification binds project,
      revision, planning input, transcript, timeline, EditBrief, capabilities,
      sequence, previous digest and stable identifiers.
- [x] Response-loss retry reuses the locally persisted `generation_id` after a
      lost POST response and failed recovery GET; a mismatched returned
      Generation ID is rejected.

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
- [x] All 13 advertised operations have strict parameters, a deterministic
      apply golden case, per-type missing/extra/wrong-type rejection where
      applicable, range rejection and ref-resolution failure coverage.
- [x] Preview renders locally and records Manifest, planned-timeline and preview
      digests plus a single exact confirmation token.
- [x] Apply rejects a missing/stale confirmation token and commits one new
      revision on the tested success path.
- [x] Named tests cover on-disk preview SHA-256 tampering, changed signed
      Manifest, changed project revision and unconfirmed export overwrite.
- [x] Export start/status/resume/cancel persist state, preserve original audio by
      default, render through shell-free FFmpeg invocation and verify the output.
- [x] Export applies no implicit `zscale`, tone-map, desaturation or BT.709
      override; uniform HLG/BT.2020 sources retain their source metadata and
      10-bit output, while mixed color profiles fail closed.
- [x] HLG export pins input decoding, filter scheduling and x265
      frame/lookahead scheduling. The named command-contract regression and a
      parallel six-second 4K HLG real-media probe produced identical output
      SHA-256 values.
- [x] A real local FFmpeg import/proxy/export smoke produced a valid MP4 with
      both H.264 video and AAC audio.

## TC-PUBLIC-SERVER-FIXTURE-001: real Server signed Manifest

- [x] Generate a deterministic `remove_range` Manifest through the real
      `creatorcut-server` policy/finalize/signing code path using test-only keys.
- [x] Verify, preview and apply that fixture in this repository without a Server
      source checkout.
- [x] Preserve the signed `track_ref`, `clip_ref` and `source_asset_ref`
      vocabulary; resolve them deterministically from the Manifest
      `base_revision` snapshot.
- [x] Reject unresolved, ambiguous or stale refs and keyset, signature,
      envelope chain, revision, input, project/Generation identifier or
      operation tampering.

## TC-PUBLIC-OPERATIONS-001: operations v1 contract

- [x] Pin one `creatorcut-operations/1.0` adjunct contract digest in the public
      client and private Server while preserving the existing Protocol v1
      bundle digest.
- [x] Give all 13 advertised operations strict parameter/precondition schemas,
      one deterministic apply golden case and named fail-closed coverage.
- [x] All 13 execution contracts passed, so no advertised operation required
      removal; private Server policy remains limited to `remove_range`.

## TC-PUBLIC-DIRECTOR-002: chain and recovery

- [x] Directly test recovery-root keyset, sequence/previous-envelope digest,
      artifact/identifier/input binding and response-loss Generation recovery.
- [x] A lost create response reuses the persisted `generation_id`; repeated
      attempts send the same ID and a mismatched response is rejected.

## TC-PUBLIC-PATH-REVISION-001: transcription safety

- [x] Transcription source resolution enforces lexical and canonical/realpath
      project boundaries and rejects symlink escape.
- [x] Transcription resume validates project ID, source digest and task/project
      `base_revision` before even returning a completed checkpoint.

## TC-PUBLIC-HOST-001: M1 supported-host fixed fixture

- [x] Codex, OpenClaw and generic text consume one signed card fixture with
      identical card, option and canonical presentation digests.
- [x] Every M1 supported-host result equals the fixture's fixed expected
      AnswerSet digest.
- [x] Director session, Generation, preview and export interruption points
      recover without duplicate Generation, apply or output overwrite.
- [x] Claude Code is deferred to a post-M1 compatibility gate and is not
      covered by this M1 completion result.

## TC-RELEASE-001: signed managed install and update

- [x] Recovery roots verify a purpose=`release` keyset with validity window,
      exactly one current key, current/previous/revoked lifecycle and monotonic
      version floor.
- [x] ReleaseManifest verification binds CreatorCut product, stable channel,
      protocol 1.0, semantic versions, exact tag, 40-hex commit, canonical
      archive SHA-256, notes URL, signing key and signature.
- [x] Tampered product, channel, tag, commit, archive digest or signature fails
      before checkout or release-code execution.
- [x] Core HTTP failure is returned directly; the client makes no unsigned
      GitHub-latest fallback request.
- [x] Clean macOS fixture installs from an isolated signed tag/source archive
      without an internal CreatorCut checkout and records the exact verified
      commit, archive digest and version.
- [x] macOS/Ubuntu and Windows installers download and SHA-256-verify the
      production Director keyset and recovery roots, pin the endpoint and
      Protocol v1 digest in the managed CLI shim, and launch the resumable
      onboarding command after installation.
- [x] Managed update refuses non-official origin, tracked local changes, active
      transcription/export tasks, concurrent update lock and keyset rollback.
- [x] Failed dependency build or smoke returns to the prior detached commit and
      reinstalls the prior build without rewriting managed metadata.
- [x] `upgrade-check` validates the current project and reports preserved state
      plus any task that defers update.
- [x] Formal public-channel reinstall verifies the stable Core Manifest,
      exact `v0.1.0` tag/commit/canonical archive, managed metadata, Node 24
      runtime, `version`, `doctor`, `update check` and a real Server/Core
      Director preflight from isolated install/Home/Keychain roots.
- [x] A routine Core production redeploy preserves the stable release registry
      and signing-key configuration; the public release endpoint remains
      verifiable instead of reverting to `503`.

## TC-SITE-001: platform-specific installation handoff

- [x] The Chinese and English hero install CTA targets the adjacent quick
      installer instead of the distant detailed-install section.
- [x] macOS, Windows and Ubuntu are explicit synchronized choices in both the
      hero and detailed install sections.
- [x] macOS and Ubuntu show the public Bash installer; Windows shows the public
      PowerShell installer. Switching either selector updates both sections.
- [x] The site contract requires both exact public commands, all three platform
      tabs, all three command panels and the `creatorcut onboard` continuation
      inside the hero section.
- [x] Desktop and mobile browser checks show the selector and corresponding
      command without horizontal page overflow.

## Cycle 3 closeout gate

The operations/ref/real-Server fixture gates, Codex MCP App UI, OpenClaw Skill,
generic-text fallback and recovery matrix passed. Cycle 3 is closed under the
user-approved M1 supported-host matrix; no additional Cycle 3 batch was added.

## Cycle 4 closeout gate

Core product release registry tests, public ReleaseManifest/keyset tests,
managed update rollback tests, shell/standalone verifier checks and the clean
macOS installer fixture passed. This closes local Cycle 4 engineering only; it
does not claim a real GitHub tag, activated Core manifest, push, deployment or
public launch.

## Cycle 5 closeout gate

The immutable RC/stable artifacts, staging three-material acceptance,
production dark deployment, approved paid canary/refund rollback, persistent
stable ReleaseManifest and formal public-channel reinstall passed. Public
managed installation is live; Core and Server paid-new-work gates remain
closed by policy.
