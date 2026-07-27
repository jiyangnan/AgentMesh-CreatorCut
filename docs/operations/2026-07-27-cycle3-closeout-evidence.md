# Cycle 3 / Batch 3 closeout evidence

- Date: 2026-07-27
- Fixture: `cycle3-closeout-v1`
- Scope: M1 public CLI, MCP, supported-host presentation, signed local
  execution and interruption recovery
- Status: Cycle 3 complete; Cycle 4 is next

## User-approved plan delta

The user explicitly instructed CreatorCut to skip Claude Code for M1. This
changes the M1 supported-host and release-test matrix without changing the
public protocol:

- M1 supported and tested: Codex native MCP App, OpenClaw Skill and generic
  text fallback.
- Deferred beyond M1: Claude Code. Its source preview remains experimental,
  is excluded from M1 support and release claims, and requires a future
  authenticated real-host compatibility gate.
- Rollback: restore Claude Code to the supported-host matrix only after a real
  host completes the same locked fixture and recovery contract; no Protocol v1
  change is required.

The delta does not add a batch, weaken signature, billing, media, path,
revision, confirmation or recovery safety, or convert a failed Claude run into
passing evidence.

## Fixed identities

- Protocol v1 bundle digest:
  `sha256:951723362bd171ad35a2194d2aa284b470db25f766bd46598b23268c9fbef59d`.
- Fixture digest:
  `sha256:00975986abab5256b187a0394869fb408a815513be49d6850531d38c9a04206b`.
- Canonical presentation digest:
  `sha256:c6414585af75d434a3220d420938e08907c82a3a88a2720583b4b4019705dc15`.
- Expected AnswerSet digest:
  `sha256:2d6927b43a55ee7adaec27523e375dd17e19cfb6c1c98a1bc1c3ea0a39f4a6f2`.

## M1 supported-host matrix

| Surface      | Evidence                                                                | Result                          |
| ------------ | ----------------------------------------------------------------------- | ------------------------------- |
| Codex        | Real CLI host re-read, native-rendered and submitted all eight cards    | Fixed AnswerSet digest accepted |
| OpenClaw     | Real `2026.6.9` Skill run completed context, consent, get and submit    | Fixed AnswerSet digest accepted |
| Generic text | Locked synthetic fallback used displayed numbered tokens through submit | Fixed AnswerSet digest accepted |

The generic-text surface is a deterministic fallback contract rather than a
separate branded host. The fixture adapter hard-fails billing, preview, apply,
transcription, media and export actions, so this matrix is not presented as
full media or production evidence.

## Recovery matrix

Named public and private tests prove:

1. A lost Director session-create response returns the original active Session.
2. A lost paid Generation response reuses the persisted `generation_id` and
   billing idempotency key.
3. A successful preview/apply advances the project once; replay fails stale.
4. Export resumes the same task and partial output, verifies SHA-256, and never
   overwrites a project asset or unconfirmed final path.

Detailed cases and repository checkpoints are preserved in
[D recovery code evidence](2026-07-27-cycle3-d-recovery-code-evidence.md).

## Independent review boundary

The existing Kimi CLI session independently returned `B/C CODE PASS`,
`D CODE PASS`, and later `B PASS` for the real Codex submission. A follow-up
review of this user-approved support-matrix delta was attempted in the same
session, but Kimi Code returned a billing-cycle quota `403` before reviewing
any file. No Kimi verdict is claimed for the delta itself. The explicit user
instruction is the scope authority; the delta must be included in the next
available Kimi release review before M1 is declared publicly launched.

## Completion boundary

Cycle 3 closes because:

- operations v1, deterministic `*_ref` resolution and the real Server signed
  fixture passed;
- all 13 advertised operations have named success and fail-closed coverage;
- Codex, OpenClaw and generic text produced the fixed expected AnswerSet;
- the four interruption points passed without duplicate Session, Generation,
  apply or output overwrite;
- Claude Code is explicitly outside the M1 support and completion claim.

This closeout is local repository and host evidence only. It is not a push,
tag, package publication, managed installation, staging/production change,
production endpoint or public release.
