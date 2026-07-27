# Cycle 3 / Batch 3 B-C host-surface evidence

- Date: 2026-07-27
- Public code checkpoint: `main@50ba975`
- Fixture: `cycle3-closeout-v1`
- Scope: Codex MCP App code, Claude Code/OpenClaw public Skills, and bounded
  real-host direction-card smoke
- Status: B passed after the real Codex submit follow-up; C and D remain open

## Fixed contract

- Protocol v1 bundle digest:
  `sha256:951723362bd171ad35a2194d2aa284b470db25f766bd46598b23268c9fbef59d`.
- Fixture digest:
  `sha256:00975986abab5256b187a0394869fb408a815513be49d6850531d38c9a04206b`.
- Canonical presentation digest:
  `sha256:c6414585af75d434a3220d420938e08907c82a3a88a2720583b4b4019705dc15`.
- Expected AnswerSet digest:
  `sha256:2d6927b43a55ee7adaec27523e375dd17e19cfb6c1c98a1bc1c3ea0a39f4a6f2`.

The canonical presentation digest is host-neutral. Each host also receives a
separate render digest for its actual presentation form. `answer_set_id` is an
opaque binding returned by `cards get`; production CLI and MCP derive it
through the single public `answerSetIdForPresentation` implementation.

## B: Codex MCP App

The checkpoint adds:

- a self-contained `ui://creatorcut/decision-cards-v1.html` MCP App resource;
- separate card data and render tools;
- authoritative card re-read before rendering and submission;
- fail-closed envelope, presentation, state-revision, and render-digest checks;
- CSP-denied networking by default, `textContent`-only DOM construction,
  origin/source-checked message bridging, and server-side normalization;
- all eight fixture card types with exact IDs, labels, descriptions, bindings,
  and an explicit no-fake-preview state for visual and voice cards.

The built stdio MCP server completed a full render-and-submit contract test and
returned the fixed expected AnswerSet digest. A real Codex CLI host loaded the
registered `creatorcut-cycle3-smoke` MCP server in thread
`019fa34a-60fe-76c0-bcf7-cdc5dcc18d3c`, recording:

- host type `codex`;
- answer set ID `answers-direction-cycle3-closeout-v1`;
- canonical presentation digest above;
- Codex render digest
  `sha256:54257e5d1b34796a4107ecd1ab9da5f6b74548d0dcd1739073d8b3d9717bf691`;
- eight cards.

The same real Codex thread then re-read the authoritative cards, rendered with
all three expected digests, and submitted all eight responses. The returned
state was `accepted: true`, `host_type: codex`, and the AnswerSet digest matched
the fixed expected digest. It stopped before quote, Generation, preview, apply,
export or billing. The 0600 evidence records `cards_get`, `cards_render` and
`cards_submit`.

The Codex desktop application forbids automated accessibility inspection, so
there is no independent screenshot assertion. That UI-security limitation is
not disguised as a visual test. The frozen B completion definition requires a
real Codex capability/presentation record and fixed-digest submit; both are now
present, so B is complete.

The same Kimi CLI session inspected the raw 0600 evidence and these completion
claims against frozen plan sections 18.5 B and 18.6 B, then returned `B PASS`
with no blocking finding. It kept C, D and Cycle 3 open.

## C: public Skills

### OpenClaw

- Version: `2026.6.9 (c645ec4)`.
- The public Skill was installed without copying credentials, endpoints, or
  Director policy.
- A pre-existing root-level
  `~/.openclaw/workspace/skills/SKILL.md` caused OpenClaw to treat that whole
  directory as one historical `botlearn` Skill. CreatorCut did not alter that
  user file; the smoke used OpenClaw's supported managed global directory.
- `openclaw skills --agent main info creatorcut --json` reported the Skill as
  eligible, model-visible, user-invocable, and command-visible.
- Real host session `e50179ac-3398-4dae-bf3a-c0f403b55968` followed the
  installed Skill through doctor, status recovery, exact context inspection,
  explicit synthetic consent, cards get, and cards submit, then stopped before
  quote/edit.
- The 0600 local evidence contained `cards_get`, `cards_render`, and
  `cards_submit`; submission was accepted with the fixed expected AnswerSet
  digest and host type `openclaw`.

This proves the real OpenClaw host can follow the public Skill and submit the
fixed direction-card round. The synthetic fixture adapter hard-fails media,
preview, apply, transcription, and export commands, so this smoke is not
Server, media, billing, or production evidence.

### Claude Code

- Version: `2.1.220`.
- `claude plugin validate ./skills/claude-code` passed.
- The namespaced `/creatorcut:creatorcut` Skill only orchestrates the public
  CLI and preserves context upload, quote, preview/apply, and export-overwrite
  confirmation boundaries.
- A real host run was attempted with the same fixed context and answers, but
  Claude Code returned `401 OAuth access token has been revoked` before any
  model or tool call.

Plugin validation is not a real-host fixture smoke. C remains open until a
valid Claude Code login completes the same fixture and recovery flow.

## Verification and review

Using Node `24.18.0`:

- format, typecheck, and build passed;
- 62 Vitest cases passed;
- 12 Node public-contract cases passed;
- the MCP stdio fixture test submitted all eight responses and matched the
  fixed expected AnswerSet digest;
- repository-boundary, secret scan, fixture lock, and Protocol v1 lock passed;
- `git diff --check` passed.

Kimi CLI session `session_94175357-6db9-4064-8dcd-f86c6536362e` reviewed all
tracked and untracked B/C changes and returned `B/C CODE PASS` with no blocking
finding. It explicitly did not close B, C, D, or Cycle 3. Its non-blocking
finding is that the test-only `creatorcut` shim manually mirrors the public CLI
envelope; therefore evidence must continue to label it as a synthetic fixture
adapter rather than the product CLI.

## Remaining gates

1. Complete a real Claude Code fixture smoke after restoring host
   authentication.
2. Close D by combining the completed Codex, OpenClaw and generic-text evidence
   with the authenticated Claude result and the four-point recovery matrix.
3. Re-run the joint Node 24, Server fixture, boundary, and Kimi review gates.

This checkpoint did not push, tag, publish a package, modify staging or
production, call Core billing, or deploy any public or private component.
