# CreatorCut agent onboarding

CreatorCut M1 is a local execution product backed by a private, signed Director.
The current repository is a development checkpoint, not an installed public
release.

## Required operating sequence

1. Run `creatorcut doctor`.
2. Authenticate through `creatorcut auth login`; supply the AgentMesh API key on
   stdin. Never place it in argv, a project, a prompt, a log or shell history.
3. Open the local `.creatorcut` project and read `project status`.
4. Run `director context inspect`. Show the complete context to the user,
   including transcript text/timing and byte count.
5. Only after explicit project-level approval, record consent with
   `director context consent --confirm-upload`.
6. Start or resume the current revision's Director session.
7. Present only the signed semantic card set returned by the Director. Preserve
   card IDs and option IDs. If native controls are unavailable, show the exact
   numbered text fallback.
8. Submit answers for the exact presentation digest and revision.
9. Show the signed Core-priced quote. A paid Generation requires a distinct,
   explicit confirmation ID.
10. Resume the same `generation_id` after timeout or host interruption.
11. Show the signed ReviewPlan and collect explicit decisions.
12. A signed Manifest still requires local preview and final confirmation before
    apply.

## Failure rules

- If Director or Core is unavailable, preserve the local project and existing
  timeline. Do not run a bundled replacement policy.
- Never invent a path, card, option, quote, session, Generation or operation.
- Reject stale revisions, stale presentation digests, invalid signatures,
  unknown options and unsupported operations.
- `requires_user_action=true` means stop and present `user_prompt`.
- Do not report completion until local export validation and user media review
  pass.
