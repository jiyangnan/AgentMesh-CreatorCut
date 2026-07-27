# CreatorCut for Claude Code

This directory is a Claude Code plugin containing the public CreatorCut Skill.
During source development, validate it with:

```bash
claude plugin validate ./skills/claude-code
claude --plugin-dir ./skills/claude-code
```

The namespaced command is `/creatorcut:creatorcut`. The Skill expects the
public `creatorcut` CLI on `PATH`; it does not include credentials, a Director
endpoint, or private strategy.
