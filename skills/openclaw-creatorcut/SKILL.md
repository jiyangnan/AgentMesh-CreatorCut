---
name: creatorcut
description: Run the public CreatorCut workflow for Chinese, English, or mixed-language talking-head videos and product recordings. Use when the user wants to import, transcribe, plan, review, edit, recover, or export a CreatorCut project.
user-invocable: true
metadata: { "openclaw": { "requires": { "bins": ["creatorcut"] } } }
---

# CreatorCut

Operate only the public `creatorcut` CLI on `PATH`. Do not read another
CreatorCut repository, a private service checkout, prompts, policies, evals,
signing material, or billing internals. The signed Director response and the
local project are the only workflow authorities.

Treat the command arguments as the user's project path and requested outcome.
If the project path is missing, ask for it. Never interpolate a path, option,
or user value into the OpenClaw `exec.command` string. For every initial
CreatorCut call, use the fixed literal command
`creatorcut __openclaw-bridge`, set the structured
`env.CREATORCUT_OPENCLAW_REQUEST_JSON` value to
`JSON.stringify({ argv, stdin_mode: "none" })`, and put the intended cwd in
`workdir`. Do not stringify `argv` by itself. Every `creatorcut ...` example
below describes argv semantics: still send its string-array argv through this
fixed bridge, never concatenate the example into shell text.

## Invariants

- Read the complete JSON envelope from every command. After honoring any
  `requires_user_action` boundary, pass `next_openclaw.exec` unchanged to the
  OpenClaw `exec` tool. Its command is a fixed bridge literal; argv stays in a
  structured environment field and is never shell text. Direct-process hosts
  use `next_process`; embedded API hosts use `next_argv`. Treat
  `next_suggested` as display-only guidance; do not infer a hidden step.
- When `next_openclaw.input.mode` is `json-line-v1`, start its exact background
  PTY exec, wait for the exact `ready_marker`, send one minified JSON line with
  `process.write`, and finish it with `process.submit`. Do not paste the JSON
  into a shell command. The bridge disables PTY echo and enforces the stated
  byte limit. Never transport an API key this way: `auth login` must be run by
  the user in a private terminal. Before stopping, retain the exact non-secret
  `next_argv` returned for `auth login`. After login completes, replace only
  its first two array items, `"auth", "login"`, with `"auth", "status"`; leave
  every remaining dependency override and project item byte-for-byte
  unchanged, then send that argv through the fixed bridge. Never include the
  API key. The returned structured continuation resumes the same scoped
  `onboard` flow with those exact local dependency overrides.
- Stop on `ok: false` and report its stable error. Retry only when
  `retryable: true`.
- A `requires_user_action: true` result is a real confirmation boundary. Do not
  cross it based on a default, prior conversation, or model judgment.
- Never upload original media, screenshots, absolute paths, or usernames to the
  Director.
- Never invent cards, card order, option IDs, defaults, edit suggestions,
  prices, or operations.
- Never run `edit generate`, `edit finalize`, `edit apply`, or overwrite export
  without the exact user confirmation required by the immediately preceding
  public result.

## Start or recover

1. Run `creatorcut doctor`.
2. Run `creatorcut project status --project "<project>"`.
3. If work may already exist, run
   `creatorcut director status --project "<project>"` before starting anything
   new. Resume the returned session or Generation; never create a duplicate.
4. For local transcription tasks, use `transcribe status` and then
   `transcribe resume` only when the returned state requires it.
5. For exports, use `export status` and then `export resume` only when the
   returned state requires it.

## Director context consent

Run:

```text
creatorcut director context inspect --project "<project>"
```

Show the user the complete returned inspection, including the byte count and
excluded fields. Only after the user explicitly approves that exact
revision-bound content, run:

```text
creatorcut director context consent --project "<project>" --confirm-upload
```

Then pass the exact `next_openclaw.exec` object to OpenClaw's exec tool when
present. Direct-process hosts use `next_process`, and embedded API hosts use
`next_argv`. Otherwise present the display-only `next_suggested` guidance and
obtain any required value.

## Signed decision cards

Run:

```text
creatorcut cards get --project "<project>"
```

Keep `data.answer_set_id`, `presentation_id`, `presentation_digest`, every
`card_id`, and every option's `submission_value` unchanged.

OpenClaw uses CreatorCut's semantic text presentation in M1. Show the exact
`text_fallback` for every card. Do not claim a visual or voice preview was
rendered or played. Preserve labels, descriptions, known-value sources, stable
IDs, and numeric submission tokens.

A Director prefill is context, not consent. Ask the user to accept or change
it. If the user supplied all exact choices in the current request, use those
choices without asking again.

Build one complete submission:

```json
{
  "answer_set_id": "<data.answer_set_id>",
  "presentation_id": "<data.presentation.presentation_id>",
  "presentation_digest": "<data.presentation.presentation_digest>",
  "responses": [
    {
      "card_id": "<stable card_id>",
      "selected_values": ["<shown submission_value>"]
    }
  ]
}
```

Use `text_value` for text cards and `approved` for review cards. Include every
required card exactly once. Start the fixed bridge for this argv:

```json
["cards", "submit", "--project", "<project>"]
```

Use its `json-line-v1` PTY contract to send the complete minified JSON through
`process.write`, then `process.submit`. Never put the answers in shell text.

Do not manually convert displayed tokens into option IDs; the public client
normalizes and validates them. If another signed card set is returned, repeat
this section using its new binding.

## Quote, review, preview, and apply

- Show the signed quote and its exact credit cost. Run `edit generate` only
  after the user explicitly accepts that quote, using a fresh confirmation ID.
- Poll or resume with `creatorcut edit status --project "<project>"`; never
  create a second Generation after a timeout or interrupted response.
- Show every signed review suggestion and collect a complete decision set
  before sending it to `edit finalize` through the same `json-line-v1` PTY
  bridge contract.
- Run `edit preview` before apply. Ask the user to inspect the local preview.
  Pass the exact returned confirmation token to `edit apply` only after the
  user confirms the preview.
- `creatorcut export status --project "<project>"` is the recovery authority.
  Export never overwrites an existing file unless the user explicitly confirms
  overwrite and the command includes `--confirm-overwrite`.

At completion, report the project revision, Manifest digest, export path, and
any remaining recovery task. Distinguish local completion from remote release
or production availability.
