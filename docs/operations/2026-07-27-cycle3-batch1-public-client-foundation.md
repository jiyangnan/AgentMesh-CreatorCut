# CreatorCut Cycle 3 / Batch 1: public client foundation

- Date: 2026-07-27
- Scope: first three Cycle 3 implementation tasks
- Status: local implementation and verification complete
- Boundary: no push, tag, installer, public release, staging mutation or
  production deployment

## Plan

1. Implement a public `creatorcut` CLI with stable JSON and secure local API-key
   storage.
2. Implement the public Cloud Director adapter, exact context inspection,
   project-level consent, signed envelope verification and resumable state.
3. Implement a public MCP server over the public runtime and Director client,
   without Studio or local policy dependencies.

## Do

- Added `packages/credentials`: macOS Keychain adapter writes secrets through
  stdin and an in-memory test adapter.
- Added `packages/runtime`: reads the current `.creatorcut` project/timeline,
  transcript and approved EditBrief; builds a path-free DirectorContext; stores
  digest-bound consent and Director state with private file permissions.
- Added `packages/host-adapters`: stable semantic presentations, native
  capability profiles and equivalent numbered text fallback.
- Added `packages/director-client`: HTTPS-only remote transport, recovery-root
  keyset verification, preflight/session/cards/quote/Generation/status/review/
  finalize/delete and persisted stable Generation recovery.
- Added `apps/cli`: stable `creatorcut-cli/1.0` output for doctor, auth, project,
  context, Director, cards and edit flow.
- Added `apps/mcp`: stdio MCP server for local project/context and signed
  Server-driven interaction.

## Check

- Node 24.14.0 typecheck passed across all public packages and apps.
- All package tests and public repository tests passed.
- Full TypeScript build passed.
- Built CLI `doctor` smoke returned a valid `creatorcut-cli/1.0` envelope.
- Repository boundary scan continued to reject private policy and credential
  markers.

## Act

- Keep Cycle 3 open.
- Next batch extracts local media import/transcription and deterministic signed
  Manifest preview/apply/undo/export.
- Then add the Codex MCP App card surface, public Claude Code/OpenClaw Skills,
  generic text smoke and interrupted-host recovery tests.
- Do not start Cycle 4 installation/release governance until all Cycle 3 checks
  pass.
