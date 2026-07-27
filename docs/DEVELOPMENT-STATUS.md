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
- [ ] Real `creatorcut-server` generated signed `remove_range` fixture,
      operation `*_ref` resolution and 13-operation test matrix.
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
- [ ] A3-A6: real Server fixture, complete named regression, evidence and
      hygiene closeout.
- [ ] B: Codex MCP App native card UI.
- [ ] C: public Claude Code and OpenClaw Skills.
- [ ] D: one signed fixture across Codex, Claude Code, OpenClaw and generic
      text, including interruption recovery.

No further Cycle 3 batch may be added without a user-approved plan delta.
