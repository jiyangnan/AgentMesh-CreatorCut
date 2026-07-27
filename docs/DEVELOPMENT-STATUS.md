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
- [x] Verified Director client for preflight, session/cards, quote, idempotent
      Generation recovery, ReviewPlan and finalize/Manifest.
- [x] Stable JSON CLI for doctor, Keychain auth, project/context, Director,
      cards and paid edit workflow.
- [x] Public stdio MCP server using only public runtime/Director client; no
      Studio or local Director policy dependency.
- [x] Cross-host semantic card presentation and generic text fallback.
- [x] Public local media import, verified proxy generation and
      Chinese/English/auto/mixed whisper.cpp transcription.
- [x] Local signed Manifest preview/apply/undo/redo and resumable export
      execution.
- [ ] Codex MCP App card UI and real Claude Code/OpenClaw host smoke.
- [ ] Public Skills and end-to-end agent onboarding verification.
- [ ] Managed installer and signed release verification.
- [ ] Real public-product dogfood.

Cycle 3 remains in progress. Batch 2 is a local implementation checkpoint, not
a remote release, tag, public installer, deployed public client, or production
endpoint. The next fixed Cycle 3 batch is the Codex MCP App UI, public Skills
and real cross-host interruption-recovery smoke.
