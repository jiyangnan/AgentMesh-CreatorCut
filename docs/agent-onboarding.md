# AgentMesh-CreatorCut agent onboarding

AgentMesh-CreatorCut is a public local-execution product backed by a private,
signed Director. Install it through the official managed channel before using
the workflow below.

macOS or Ubuntu:

```bash
curl -fsSL https://raw.githubusercontent.com/jiyangnan/AgentMesh-CreatorCut/main/scripts/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/jiyangnan/AgentMesh-CreatorCut/main/scripts/install.ps1 | iex
```

The official installer verifies the signed release and public Director trust
bundle, then invokes `creatorcut onboard`. If the terminal or host is
interrupted, resume with the same command. The command returns one stable JSON
envelope describing the current onboarding stage, whether user action is
required, and the exact `next_suggested` command.

## Required operating sequence

1. Run `creatorcut onboard`. Do not guess the next action; follow its
   `next_suggested` field.
2. The onboarding command runs the equivalent of `creatorcut doctor` and stops
   with a repair action if Node, FFmpeg, FFprobe, whisper.cpp, the local model,
   or the pinned Director trust configuration is missing.
3. Authenticate through `creatorcut auth login`; supply the AgentMesh API key
   on stdin. It is stored in macOS Keychain, Windows DPAPI, or Linux Secret
   Service. Never place it in argv, a project, a prompt, a log or shell history.
4. Import the recording with `media import`, then run local transcription with
   `transcribe start --language zh|en|auto|mixed`. Resume the same task after an
   interruption; do not invent a transcript.
5. Open the local `.creatorcut` project and read `project status`.
6. Run `creatorcut onboard` again. It resumes at transcription or Director
   consent for the current project rather than restarting completed stages.
7. Run `director context inspect`. Show the complete context to the user,
   including transcript text/timing and byte count.
8. Only after explicit project-level approval, record consent with
   `director context consent --confirm-upload`.
9. Start or resume the current revision's Director session.
10. Present only the signed semantic card set returned by the Director. Preserve
    card IDs and option IDs. If native controls are unavailable, show the exact
    numbered text fallback. Native controls submit the exact `option_id`; the
    numbered fallback submits the displayed numeric `submission_value`. The
    public normalizer accepts either representation and always emits the same
    semantic option ID.
11. Submit answers for the exact presentation digest and revision.
12. Show the signed Core-priced quote. A paid Generation requires a distinct,
    explicit confirmation ID.
13. Resume the same `generation_id` after timeout or host interruption.
14. Show the signed ReviewPlan and collect explicit decisions.
15. Re-fetch and verify the signed Manifest, run `edit preview`, and show the
    actual local preview. Apply only with the exact preview confirmation token.
16. Export locally and inspect the completed task. Do not overwrite an existing
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
- If a persisted `finalizing` export has invalid partial bytes, fail closed.
  Inspect and remove only that task's hidden partial file, or select a new
  output, before retrying; never silently replace unknown bytes.
- `requires_user_action=true` means stop and present `user_prompt`.
- Do not report completion until local export validation and user media review
  pass.
