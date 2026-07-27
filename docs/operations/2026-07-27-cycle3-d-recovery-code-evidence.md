# Cycle 3 / Batch 3 D recovery code evidence

- Date: 2026-07-27
- Public checkpoint: `AgentMesh-CreatorCut main@e6ccf27`
- Private checkpoint: `creatorcut-server main@a796487`
- Fixture: `cycle3-closeout-v1`
- Status: D code and named recovery tests passed; B passed in the subsequent
  real Codex submit; C, D and Cycle 3 remain open

> Superseded completion note: the explicit 2026-07-27 user plan delta deferred
> Claude Code beyond M1. This document remains the historical D code
> checkpoint; final M1 status is recorded in
> [Cycle 3 closeout](2026-07-27-cycle3-closeout-evidence.md).

## Frozen identities

- Protocol v1 bundle digest:
  `sha256:951723362bd171ad35a2194d2aa284b470db25f766bd46598b23268c9fbef59d`.
- Fixture digest:
  `sha256:00975986abab5256b187a0394869fb408a815513be49d6850531d38c9a04206b`.
- Canonical presentation digest:
  `sha256:c6414585af75d434a3220d420938e08907c82a3a88a2720583b4b4019705dc15`.
- Expected AnswerSet digest:
  `sha256:2d6927b43a55ee7adaec27523e375dd17e19cfb6c1c98a1bc1c3ea0a39f4a6f2`.

No Protocol v1 file changed in this checkpoint. The public lock and standalone
package tests passed.

## Recovery matrix

| Interruption point               | Persisted identity or guard                                                                                  | Named evidence                                                                                                                                     | Result                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Director session create response | Active session is unique on account, project, base revision and planning-input digest                        | Public `retries a lost session-create response...`; Server `recovers one persisted session...`; memory and real PostgreSQL concurrent-create tests | Retry returns the original session ID; no second active session is created                                                            |
| Paid Generation create response  | `generation_id`, quote, confirmation and planning bindings persist before retry                              | Public `persists and reuses the Generation ID...`; Server paid-flow and Generation-conflict tests                                                  | Retry reuses one Generation and one debit idempotency key; conflicting rebinding is rejected without a second charge                  |
| Preview or apply response        | Preview bytes, Manifest digest, base revision and one-time confirmation token                                | Media-engine `requires an unchanged rendered preview...` and tamper/revision tests                                                                 | A successful apply advances revision once; replaying the same token fails stale and cannot apply twice                                |
| Render or export finalization    | Stable `task_id`, base revision, hidden same-directory partial path, expected SHA-256 and `finalizing` state | Media-engine interrupted-resume, materialized-finalization and tampered-locator tests                                                              | Retry preserves one task ID, does not rerender already materialized bytes and never overwrites an unconfirmed output or project asset |

### Session persistence

`creatorcut-server` migration
`002_active_session_idempotency.sql` fails closed if an older database already
contains duplicate non-deleted session bindings, then creates a partial unique
index for future writes. PostgreSQL `ON CONFLICT` returns the winner's original
row during concurrent retries. The in-memory test store implements the same
observable behavior.

A deliberate `DELETE` is the restart boundary for identical input: while a
session is non-deleted, the same account, project, revision and planning digest
resume it; after deletion, a new session may be created.

### Export persistence

Rendering writes to a stable hidden partial file in the final output directory.
The task persists `finalizing` with the rendered SHA-256 before materializing
the final path. Recovery therefore distinguishes:

- interrupted render with no trusted result: discard the partial and rerender
  under the same task ID;
- trusted finalizing partial: verify and materialize it;
- final output already materialized with the expected SHA-256: complete
  without invoking the renderer;
- mismatched output, project-asset target or invalid finalizing bytes: fail
  closed without overwriting.

Corrupted bytes in a persisted `finalizing` task are intentionally not
self-healed. An operator must inspect and remove the task's hidden partial file
or select a new output before retrying; CreatorCut must not silently replace
unknown bytes.

## Host consistency checkpoint

The new generic-text public-contract test runs the locked synthetic fixture
through doctor, project status, context inspection, explicit consent, Director
start, card retrieval and card submission. It submits the numbered tokens
shown by the text fallback and reaches the fixed expected AnswerSet digest.

Current real-host status remains:

| Host         | Current evidence                                                                                           | Completion state                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Codex        | Real CLI host re-read, native-rendered and submitted all eight cards; the fixed answer digest was accepted | B passed; desktop screenshot automation remains unavailable by product safety policy |
| Claude Code  | Plugin validation passed                                                                                   | Deferred beyond M1; no real-host support claim                                       |
| OpenClaw     | Real `2026.6.9` Skill run submitted the fixed AnswerSet and stopped before quote/edit                      | Real direction-round checkpoint passed                                               |
| Generic text | Locked synthetic fixture completed with displayed numbered tokens                                          | Code-level fixture smoke passed                                                      |

The synthetic fixture adapter hard-fails media, billing, preview, apply,
transcription and export commands. It is not production, Core, Server or real
media evidence.

## Verification

Using Node `24.18.0`:

- public `pnpm verify`: formatting, typecheck and build passed; 66 Vitest and
  13 Node public-contract tests passed;
- private Server `pnpm verify`: formatting, typecheck and build passed; 16 test
  files and 60 tests passed, with the environment-gated PostgreSQL file skipped;
- a separate isolated PostgreSQL 16 run executed the real migration and all 7
  store integration tests successfully;
- `git diff --check`, the public repository-boundary test, credential-pattern
  scan, fixture lock and Protocol v1 lock passed.

Kimi CLI session `session_94175357-6db9-4064-8dcd-f86c6536362e` inspected both
repository diffs and returned `D CODE PASS` with no blocking finding. It
kept B, C, D and Cycle 3 open at that code checkpoint; the subsequent real
Codex submit closed B.

This checkpoint did not push, tag, publish, modify Core, touch staging or
production, call a live ledger, or deploy any component.
