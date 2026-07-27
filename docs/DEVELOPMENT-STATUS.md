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
- [x] Public stdio MCP server using only public runtime/Director client; no
      Studio or local Director policy dependency.
- [x] Cross-host semantic card presentation and generic text fallback adapters
      have unit-level capability/presentation coverage.
- [x] Public local media import, verified proxy generation and
      Chinese/English/auto/mixed whisper.cpp transcription.
- [x] Local Manifest preview/apply/undo/redo and resumable export execution
      checkpoint.
- [x] Real `creatorcut-server` generated signed `remove_range` fixture and
      deterministic operation `*_ref` resolution.
- [x] Complete named 13-operation apply/fail-closed test matrix.
- [ ] Codex MCP App card UI and real Claude Code/OpenClaw host smoke.
- [ ] Public Skills and end-to-end agent onboarding verification.
- [ ] Managed installer and signed release verification.
- [ ] Real public-product dogfood.

Cycle 3 remains in progress. Batch 2 is a local implementation checkpoint: it
did not use a Manifest produced and signed by the real `creatorcut-server`
policy/finalize path, so it is not evidence of a completed Server-to-client
operation contract. The only remaining Cycle 3 batch is Batch 3: first close
the operations/ref/fixture/test gaps, then deliver the Codex MCP App, public
Skills and real four-host interruption-recovery evidence. It is not a remote
release, tag, public installer, deployed public client, or production endpoint.

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
- [ ] B: Codex MCP App native card UI.
- [ ] C: public Claude Code and OpenClaw Skills.
- [ ] D: one signed fixture across Codex, Claude Code, OpenClaw and generic
      text, including interruption recovery.

No further Cycle 3 batch may be added without a user-approved plan delta.

### B-C code and host checkpoint

- Public code checkpoint `main@50ba975` contains the Codex MCP App resource,
  authoritative render/submit path, one canonical presentation digest,
  host-specific render digests, and public Claude Code/OpenClaw Skills.
- Node `24.18.0` `pnpm verify` passed with 62 Vitest and 12 Node
  public-contract cases; Protocol v1 remains frozen.
- The built MCP stdio contract rendered and submitted all eight fixture cards
  and matched the fixed expected AnswerSet digest.
- A real Codex CLI host rendered all eight cards in a desktop-visible thread,
  but independent native-widget visual inspection and host submission are
  still missing; B remains open.
- OpenClaw `2026.6.9` installed and invoked the Skill, submitted the fixed
  AnswerSet successfully, and stopped before quote/edit.
- Claude Code `2.1.220` plugin validation passed, but its real host call failed
  before tool execution because the local OAuth token was revoked; C remains
  open.
- Kimi CLI returned `B/C CODE PASS` with no blocking code finding and explicitly
  kept B, C, D, and Cycle 3 open.
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

D remains open because Codex native submit and authenticated Claude Code
real-host evidence are still missing. This checkpoint is not Cycle 3 closeout.

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
  Before B starts, the canonical presentation digest algorithm must be aligned
  with the public host adapter; B-D remain incomplete.
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
  FFmpeg smoke remains the media evidence; Codex/Claude Code/OpenClaw/generic
  host evidence remains B-D.
