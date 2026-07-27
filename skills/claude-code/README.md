# CreatorCut for Claude Code

> Experimental, post-M1 preview. Claude Code is not an M1 supported or
> release-tested host. Do not advertise or install this plugin as part of the
> M1 supported-host matrix until a separate real-host compatibility gate
> passes.

This directory is a Claude Code plugin containing the public CreatorCut Skill.
During source development, validate it with:

```bash
claude plugin validate ./skills/claude-code
claude --plugin-dir ./skills/claude-code
```

The namespaced command is `/creatorcut:creatorcut`. The Skill expects the
public `creatorcut` CLI on `PATH`; it does not include credentials, a Director
endpoint, or private strategy.
