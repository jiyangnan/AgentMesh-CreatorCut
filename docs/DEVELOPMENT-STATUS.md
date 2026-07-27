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
- [ ] Named response-loss/idempotent Generation recovery tests.
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
- [ ] Complete named 13-operation apply/fail-closed test matrix.
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
- [ ] A4-A6: complete named regression, evidence and hygiene closeout.
- [ ] B: Codex MCP App native card UI.
- [ ] C: public Claude Code and OpenClaw Skills.
- [ ] D: one signed fixture across Codex, Claude Code, OpenClaw and generic
      text, including interruption recovery.

No further Cycle 3 batch may be added without a user-approved plan delta.

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
