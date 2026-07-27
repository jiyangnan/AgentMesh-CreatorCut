---
name: creatorcut
description: Run the public CreatorCut workflow for Chinese, English, or mixed-language talking-head videos and product recordings. Use when the user wants to import, transcribe, plan, review, edit, recover, or export a CreatorCut project.
argument-hint: "[project path and requested outcome]"
user-invocable: true
---

# CreatorCut

This Skill is an experimental post-M1 compatibility preview. Its presence in
source does not mean Claude Code is an M1 supported or release-tested host.

Operate only the public `creatorcut` CLI on `PATH`. Do not read another
CreatorCut repository, a private service checkout, prompts, policies, evals,
signing material, or billing internals. The signed Director response and the
local project are the only workflow authorities.

Treat `$ARGUMENTS` as the user's project path and requested outcome. If the
project path is missing, ask for it. Quote every path passed to the shell.

## Invariants

- Read the complete JSON envelope from every command. Follow
  `next_suggested`; do not infer a hidden step.
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

Then follow `next_suggested`.

## Signed decision cards

Run:

```text
creatorcut cards get --project "<project>"
```

Keep `data.answer_set_id`, `presentation_id`, `presentation_digest`, every
`card_id`, and every option's `submission_value` unchanged.

Claude Code does not claim CreatorCut visual or voice preview support. For
`single`, `multi`, and `review` cards, use `AskUserQuestion` when it can
faithfully represent the options; otherwise show the exact `text_fallback`.
For `text`, `visual`, or `voice` cards, show the exact fallback label,
description, known-value source, and `preview_ref` without claiming the preview
was rendered or played.

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
required card exactly once. Pipe the complete JSON to:

```text
creatorcut cards submit --project "<project>"
```

Do not manually convert displayed tokens into option IDs; the public client
normalizes and validates them. If another signed card set is returned, repeat
this section using its new binding.

## Quote, review, preview, and apply

- Show the signed quote and its exact credit cost. Run `edit generate` only
  after the user explicitly accepts that quote, using a fresh confirmation ID.
- Poll or resume with `creatorcut edit status --project "<project>"`; never
  create a second Generation after a timeout or interrupted response.
- Show every signed review suggestion and collect a complete decision set
  before piping it to `edit finalize`.
- Run `edit preview` before apply. Ask the user to inspect the local preview.
  Pass the exact returned confirmation token to `edit apply` only after the
  user confirms the preview.
- `creatorcut export status --project "<project>"` is the recovery authority.
  Export never overwrites an existing file unless the user explicitly confirms
  overwrite and the command includes `--confirm-overwrite`.

At completion, report the project revision, Manifest digest, export path, and
any remaining recovery task. Distinguish local completion from remote release
or production availability.
