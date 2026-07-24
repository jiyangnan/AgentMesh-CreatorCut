# AgentMesh-CreatorCut

AgentMesh-CreatorCut is the public execution product for CreatorCut: an Agent
for intelligent post-production of talking-head videos and product screen
recordings.

M1 is designed for Chinese, English, and mixed-language recordings. The public
client will keep media processing local, render Director-driven interactive
cards across hosts, verify signed edit plans, preview changes, and apply only
declarative reversible operations.

## Current status

This repository is at the first M1 release-engineering checkpoint. It currently
contains the frozen public Protocol v1 and its signature, resource-limit, and
safe-operation tests.

The CLI, MCP server, local runtime, Director client, host adapters, skills, and
installer listed in the M1 release plan have not yet been exported here. There
is no public release, tag, remote installation command, or production Director
endpoint yet.

## Product boundary

```text
AgentMesh-CreatorCut (public, local execution)
  -> creatorcut-server (private Director strategy)
  -> agentmesh-core (identity, entitlements, price and credits)
```

`CreatorCut` is the internal Studio/dogfood source. `creatorcut-server` owns card
orchestration, semantic editing policy, signed plan generation, and billing
recovery. `agentmesh-core` remains the shared control plane and price source.
This product does not depend on `AgentMesh360-Client`.

See [System boundary](docs/CREATORCUT-SYSTEM-BOUNDARY.md) for the data and trust
model.

## Development

Requirements:

- Node 24
- pnpm 10

```bash
pnpm install
pnpm verify
pnpm protocol:digest
pnpm pack:protocol
```

`pnpm protocol:digest` prints the stable digest that private consumers must pin.
`pnpm pack:protocol` builds the independently consumable protocol tarball used
by private services during this pre-release phase.

## License

Apache-2.0. See [LICENSE](LICENSE).
