# CreatorCut for OpenClaw

Install the public Skill into the current OpenClaw workspace:

```bash
openclaw skills install ./skills/openclaw-creatorcut --as creatorcut
openclaw skills info creatorcut
```

The Skill expects the public `creatorcut` CLI on `PATH`; it contains no
credentials, endpoint, private strategy, or billing implementation. ClawHub
publication remains a release step after the real-host smoke passes.
