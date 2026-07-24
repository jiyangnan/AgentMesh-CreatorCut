# CreatorCut Public Protocol

This package is the public, host-neutral contract between the CreatorCut
Director service and local CreatorCut execution clients.

It contains only schemas, canonicalization, signature verification, stable
limits, and deterministic fixtures. It does not contain Director policy,
prompts, model routing, private evaluation data, credentials, media, or local
filesystem paths.

The package is independently buildable and publishes compiled ESM plus
declarations:

```bash
pnpm build
pnpm pack
```

`DirectorContext` carries only user-inspected transcript text, opaque media and
timeline references, local silence/timing facts, capability IDs, and optional
non-image `VisualEventSummary`. It never carries source media, screenshots, or
filesystem paths.

Protocol families frozen in the M1 baseline:

- `creatorcut-director-protocol/1.0`
- `creatorcut-project/1.0`
- `creatorcut-operation/1.0`
- `creatorcut-host-card/1.0`
- `creatorcut-error-envelope/1.0`
- `creatorcut-limits/1.0`
