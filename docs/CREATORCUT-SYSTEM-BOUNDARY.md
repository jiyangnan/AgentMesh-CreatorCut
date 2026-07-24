# CreatorCut system boundary

## Product layers

| Layer                         | Responsibility                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| Internal `CreatorCut`         | Studio, dogfood, private evaluation and upstream capability development             |
| Public `AgentMesh-CreatorCut` | CLI/MCP, local project and media execution, protocol verification and host adapters |
| Private `creatorcut-server`   | Director card orchestration, edit policy, signing, Generation and billing recovery  |
| Shared `agentmesh-core`       | Identity, entitlements, pricing, credits and official release trust                 |
| `agentmesh-deploy`            | Immutable build, deployment, verification and rollback operations                   |

`AgentMesh360-Client` is not a CreatorCut M1 dependency.

## Data boundary

Media, proxies, local paths, previews, timelines, and exports stay local by
default. A user must inspect and explicitly consent to the exact
DirectorContext before upload. A complete transcript remains user content; it
must not be described as anonymized.

Product recordings send a locally generated `VisualEventSummary` by default,
not source video or screenshots. M1 does not claim server-side visual semantic
understanding.

## Strategy boundary

The private Director decides when to ask an interactive card, which defaults and
risks to present, how to create an edit review, and how to finalize a signed
manifest. The public product declares local capabilities, renders equivalent
cards across hosts, verifies signed artifacts, previews the result, requests
final confirmation, and applies only revision-bound declarative operations.

## Protocol authority

`packages/protocol` is the public Protocol v1 authority. Private and internal
consumers pin the digest printed by `pnpm protocol:digest`. New operation types
must enter the public schema, capability negotiation, and safety tests before a
Director may issue them.

Core is the only price source. No fixed credit amount belongs in the client or
private Server code.
