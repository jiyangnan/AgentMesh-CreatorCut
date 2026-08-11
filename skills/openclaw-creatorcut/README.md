# CreatorCut for OpenClaw

Install the public Skill into the current OpenClaw workspace:

```bash
openclaw skills install ./skills/openclaw-creatorcut --as creatorcut --force
openclaw skills info creatorcut
```

The command intentionally replaces an older CreatorCut Skill in the
cwd-inferred/default agent workspace. Add `--agent YOUR_AGENT_ID` when the
intended agent is not the default. It does not install globally; use `--global`
only when every local agent should receive this Skill.

The CreatorCut CLI and OpenClaw Skill must come from the same verified release
archive. Before using v0.3.0-rc.3, reinstall this matching Skill from that RC
archive; the CLI deliberately rejects old OpenClaw Skills that execute
display-only `next_suggested` text instead of the fixed bridge. This protects
project paths and prevents shell interpolation during a mixed-version update.

The Skill expects the public `creatorcut` CLI on `PATH`; it contains no
credentials, endpoint, private strategy, or billing implementation. ClawHub
publication remains a release step after the real-host smoke passes.
