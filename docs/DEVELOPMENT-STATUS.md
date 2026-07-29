# Development status

## M1 release engineering

- [x] Independent public repository scaffold.
- [x] Protocol v1 schemas and TypeScript types.
- [x] Strict canonical JSON and Ed25519 Director/keyset verification.
- [x] Public resource limits and declarative-operation safety validation.
- [x] Stable protocol bundle digest and repository privacy scan.
- [x] Protocol package builds to standalone Node 24 ESM, declarations and bundled JSON Schema.
- [x] DirectorContext includes path-free planning facts, capabilities, AnswerSet and ReviewDecisionSet.
- [x] Local read-only project/runtime compatibility layer for current
      `.creatorcut` project, timeline, transcript and approved EditBrief.
- [x] Project-level DirectorContext inspection, exact digest-bound consent,
      private local Director state and consent revocation.
- [x] Director client implementation for preflight, session/cards, quote,
      locally persisted Generation IDs, ReviewPlan and finalize/Manifest.
- [x] Named response-loss/idempotent Generation recovery tests.
- [x] Stable JSON CLI for doctor, Keychain auth, project/context, Director,
      cards and paid edit workflow.
- [x] Resumable `creatorcut onboard` state machine connects environment repair,
      secure login, local media import, multilingual transcription, explicit
      context consent, and Director start through stable `next_suggested`
      actions.
- [x] Public stdio MCP server using only public runtime/Director client; no
      Studio or local Director policy dependency.
- [x] Cross-host semantic card presentation and generic text fallback adapters
      have unit-level capability/presentation coverage.
- [x] Public local media import, verified proxy generation and
      Chinese/English/auto/mixed whisper.cpp transcription.
- [x] Local Manifest preview/apply/undo/redo and resumable export execution
      checkpoint.
- [x] Local rendering preserves a uniform source color profile and bit depth;
      it does not apply implicit HDR-to-SDR tone mapping, desaturation or
      forced BT.709 tagging, and mixed source profiles fail closed.
- [x] Real `creatorcut-server` generated signed `remove_range` fixture and
      deterministic operation `*_ref` resolution.
- [x] Complete named 13-operation apply/fail-closed test matrix.
- [x] Codex MCP App card UI, real OpenClaw Skill smoke, and generic-text
      fallback smoke.
- [x] M1 host onboarding verification for Codex, OpenClaw and generic text.
- [x] Claude Code compatibility is explicitly deferred to post-M1 and is not
      part of the M1 supported-host or release-test matrix.
- [x] macOS managed installer, recovery-root-signed ReleaseManifest
      verification, update deferral, compatibility check and rollback.
- [x] Managed installers pin and verify the public Director keyset, recovery
      roots, endpoint and Protocol v1 digest before entering onboarding.
- [x] The Chinese, English, Japanese and Korean website keeps the install CTA adjacent to a
      synchronized macOS, Windows and Ubuntu selector; each platform exposes
      only its exact public command before entering the shared onboarding flow.
- [x] The four-language website exposes an explicit AgentMesh360 brand
      backlink in the desktop header and all-viewport footer, matching the
      ecosystem discovery contract used by sibling product websites.
- [x] The four-language website exposes direct AgentMesh360 pass purchase
      actions in the header, hero, Director pricing card and footer without
      changing the local-media or credit boundary.
- [x] Japanese and Korean are complete localized pages with a four-language
      switch and reciprocal `hreflang` metadata on every locale.
- [x] Real RC11 public-product installation and three-material dogfood.
- [x] Immutable public stable `v0.2.1` tag, canonical archive and formal
      GitHub Release.
- [x] Production dark deployment, approved 50-credit paid canary/refund
      rollback, persistent Core stable ReleaseManifest and formal clean
      public-channel reinstall with real Server/Core preflight.

Cycle 1–5 are complete. The stable managed-install channel serves `v0.2.1` and
survives a routine Core production redeploy because the release registry and
signing configuration are persisted in the production workflow. Batch 3
closed the real signed fixture, Codex MCP App, OpenClaw Skill, generic-text
fallback and four-point interruption-recovery gaps. The user-approved plan
delta defers Claude Code to post-M1 and removes it from M1 completion claims.
Production Director admission is open at the Core-authoritative price of 50
credits per confirmed signed plan.

## Cycle 4 closeout

- [x] Core uses a product-keyed metadata registry plus a separate server-only
      signing-key registry; the legacy Job Agent release fields remain a
      backward-compatible fallback.
- [x] `/v1/products/creatorcut/client-release` is present and returns 503 until
      a real RC tag, commit, canonical archive digest, notes and signing key are
      configured.
- [x] `scripts/install.sh` supports macOS, installs to
      `~/.local/share/creatorcut`, creates a `~/.local/bin/creatorcut` shim and
      records managed version/commit/archive/keyset metadata.
- [x] Installer prerequisite checks cover Node 24, FFmpeg, FFprobe,
      whisper.cpp and the selected local model, with explicit recovery actions.
- [x] Recovery-root-signed release keyset and signed Core ReleaseManifest are
      verified before release code is checked out or executed.
- [x] Product, channel, protocol, tag, commit, archive SHA-256, signing key
      state and monotonic keyset floor all fail closed on mismatch.
- [x] `creatorcut update check`, `update apply`, `upgrade-check` and `version`
      use stable CLI envelopes.
- [x] Queued/running/finalizing transcription or export defers update; project,
      Director state, tasks, versions and choices live outside the managed
      install and are preserved.
- [x] Failed build/smoke restores the previous detached commit and dependencies.
- [x] Core outage produces no unsigned GitHub-latest fallback; all other
      installed local commands remain independent of the release endpoint.
- [x] Clean macOS installer fixture used an isolated tagged public-source shape
      with no internal CreatorCut checkout and verified the resulting shim and
      metadata.

Exact evidence:
[Cycle 4 managed release closeout](operations/2026-07-27-cycle4-managed-release-closeout.md).
[Cycle 5 RC11 staging acceptance](operations/2026-07-28-cycle5-rc11-staging-acceptance.md).
[Cycle 5 stable production release](operations/2026-07-28-cycle5-v0.1.0-production-release.md).

## Cycle 3 / Batch 3 closeout

- [x] A0 draft freezes packages A–D, `creatorcut-operations/1.0`, the
      `*_ref` resolver, deterministic Server fixture, test matrix, DoD,
      evidence corrections and the no-expansion boundary.
- [x] A0 passed review in the existing Kimi CLI session with no blocking
      finding.
- [x] A1: independent operations contract, cross-repository digest/tarball pin
      and Server `remove_range`-only guard; Protocol v1 digest is unchanged.
- [x] A2: immutable base-ref resolver, explicit output ref map and named
      fail-closed tests.
- [x] A3: deterministic sanitized real-Server fixture independently verifies,
      rebuilds its base-revision project, previews and applies without a
      Server source checkout.
- [x] A4: named Director recovery, 13-operation, ref, path/revision and
      preview/export tamper regressions.
- [x] A5: completion claims are bound to named tests, fixed digests and the
      exact smoke scope recorded below.
- [x] A6: one capabilities builder, correct MCP envelope/presentation digests,
      realpath-safe transcription and revision-bound resume.
- [x] B: Codex MCP App native card UI.
- [x] C: public OpenClaw Skill completed the real fixed-fixture smoke.
- [x] D: one signed fixture across the M1 supported host matrix—Codex,
      OpenClaw and generic text—plus Director session, Generation, preview and
      export interruption recovery.
- [x] Claude Code: post-M1 experimental compatibility only; not an M1 gate.

No further Cycle 3 batch may be added without a user-approved plan delta.

### B-C code and host checkpoint

- Public code checkpoint `main@50ba975` contains the Codex MCP App resource,
  authoritative render/submit path, one canonical presentation digest,
  host-specific render digests, and public Claude Code/OpenClaw Skills.
- Node `24.18.0` `pnpm verify` passed with 62 Vitest and 12 Node
  public-contract cases; Protocol v1 remains frozen.
- The built MCP stdio contract rendered and submitted all eight fixture cards
  and matched the fixed expected AnswerSet digest.
- A real Codex CLI host re-read, native-rendered and submitted all eight cards
  in thread `019fa34a-60fe-76c0-bcf7-cdc5dcc18d3c`; the fixed expected
  AnswerSet digest was accepted. Codex blocks automated desktop accessibility
  inspection, so no screenshot assertion is claimed. The frozen B real-host
  completion definition is satisfied; the same Kimi CLI session independently
  inspected the raw evidence and returned `B PASS`.
- OpenClaw `2026.6.9` installed and invoked the Skill, submitted the fixed
  AnswerSet successfully, and stopped before quote/edit.
- Claude Code `2.1.220` plugin validation passed, but its real host call failed
  before tool execution because the local OAuth token was revoked. The user
  subsequently deferred Claude Code beyond M1; no real-host support is claimed.
- Kimi CLI returned `B/C CODE PASS` with no blocking code finding at the code
  checkpoint. The later user-approved plan delta narrowed the M1 host gate
  without changing the public protocol or host-adapter code.
- Exact bounded evidence:
  [Cycle 3 B-C host surfaces](operations/2026-07-27-cycle3-b-c-host-surfaces.md).

### D recovery-code checkpoint

- Public checkpoint `main@e6ccf27` completes the generic-text fixture smoke,
  response-loss session retry, same-ID export resume, finalizing/materialized
  recovery, duplicate-apply rejection and project-asset overwrite guard.
- Private checkpoint `creatorcut-server main@a796487` adds checksum-pinned
  migration 002 and concurrent active-session deduplication across memory and
  PostgreSQL stores.
- Public Node `24.18.0` `pnpm verify` passed with 66 Vitest and 13 Node
  public-contract cases. Server `pnpm verify` passed with 60 tests; an isolated
  PostgreSQL 16 run separately passed all 7 store integration cases.
- Protocol v1, fixture, canonical presentation and expected AnswerSet digests
  remain frozen.
- The same Kimi CLI session returned `D CODE PASS` with no blocking finding.
- Exact bounded evidence:
  [Cycle 3 D recovery code](operations/2026-07-27-cycle3-d-recovery-code-evidence.md).

D is closed under the user-approved M1 host matrix. The combined closeout
evidence is recorded in
[Cycle 3 closeout](operations/2026-07-27-cycle3-closeout-evidence.md).

### A3 evidence

- Fixture digest:
  `sha256:00975986abab5256b187a0394869fb408a815513be49d6850531d38c9a04206b`.
- Manifest envelope digest:
  `sha256:7a9d47a7190a5252d82b38eb3a4e28b5f417e7ead8f88fae8fc595f738dd9b83`.
- The public contract test verifies the recovery-root-signed keyset and
  five-envelope chain, reconstructs the revision-3 synthetic project from the
  fixture snapshot, previews and applies two signed `remove_range` operations,
  and commits revision 4 with duration reduced from 8,000,000 to 7,070,000
  microseconds.
- The fixed host interaction in this A3 fixture is the direction-card round.
  The canonical presentation digest algorithm was aligned with the public host
  adapter before B, and B-D are now complete under the M1 host matrix.
- Kimi CLI session `session_94175357-6db9-4064-8dcd-f86c6536362e` returned
  `A3 PASS`. The tested renderer is a shell-free mocked media runner, so this
  contract result does not replace a real FFmpeg smoke.

### A4-A6 evidence

- [Cycle 3 A4-A6 contract and recovery evidence](operations/2026-07-27-cycle3-batch3-a4-a6-contract-recovery.md)
  lists every named test file and the exact verified scope.
- Node `24.18.0` `pnpm verify` passed with 58 Vitest cases and 9 Node public
  contract cases. `git diff --check` passed.
- Protocol v1 remains
  `sha256:951723362bd171ad35a2194d2aa284b470db25f766bd46598b23268c9fbef59d`
  and now has a public lock test. The fixture and Manifest envelope digests
  remain unchanged.
- The same Kimi CLI session first rejected a misplaced capabilities builder
  because it changed the frozen protocol digest, then returned `A4+A6 PASS`
  after the builder moved to a non-protocol package and the Node 24 gate
  passed.
- A4-A6 did not run a new real FFmpeg or real-host smoke. The earlier Batch 2
  FFmpeg smoke remains the media evidence; subsequent Codex/OpenClaw/generic
  evidence closes B-D. Claude Code remains post-M1 experimental.
