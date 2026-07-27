# CreatorCut agent onboarding

CreatorCut M1 is a local execution product backed by a private, signed Director.
The current repository is a development checkpoint, not an installed public
release.

## Required operating sequence

1. Run `creatorcut doctor`.
2. Authenticate through `creatorcut auth login`; supply the AgentMesh API key on
   stdin. Never place it in argv, a project, a prompt, a log or shell history.
3. Import the recording with `media import`, then run local transcription with
   `transcribe start --language zh|en|auto|mixed`. Resume the same task after an
   interruption; do not invent a transcript.
4. Open the local `.creatorcut` project and read `project status`.
5. Run `director context inspect`. Show the complete context to the user,
   including transcript text/timing and byte count.
6. Only after explicit project-level approval, record consent with
   `director context consent --confirm-upload`.
7. Start or resume the current revision's Director session.
8. Present only the signed semantic card set returned by the Director. Preserve
   card IDs and option IDs. If native controls are unavailable, show the exact
   numbered text fallback.
9. Submit answers for the exact presentation digest and revision.
10. Show the signed Core-priced quote. A paid Generation requires a distinct,
    explicit confirmation ID.
11. Resume the same `generation_id` after timeout or host interruption.
12. Show the signed ReviewPlan and collect explicit decisions.
13. Re-fetch and verify the signed Manifest, run `edit preview`, and show the
    actual local preview. Apply only with the exact preview confirmation token.
14. Export locally and inspect the completed task. Do not overwrite an existing
    output unless the user explicitly confirmed that exact overwrite.

## Failure rules

- If Director or Core is unavailable, preserve the local project and existing
  timeline. Do not run a bundled replacement policy.
- Never invent a path, card, option, quote, session, Generation or operation.
- Reject stale revisions, stale presentation digests, invalid signatures,
  unknown options and unsupported operations.
- Reject a changed preview file, stale preview token, project asset path escape,
  symlink escape, output path collision and export overwrite without explicit
  confirmation.
- `requires_user_action=true` means stop and present `user_prompt`.
- Do not report completion until local export validation and user media review
  pass.
