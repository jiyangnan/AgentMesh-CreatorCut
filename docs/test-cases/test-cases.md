# AgentMesh-CreatorCut test cases

## TC-PROTO-001: canonical signatures

- [x] JCS is stable and rejects non-JSON or ambiguous inputs.
- [x] Director envelopes reject tampering, expiration, revoked keys, and keyset rollback.
- [x] Artifact-specific identity fields cannot be mixed.

## TC-PROTO-002: safe public operations

- [x] Manifests are revision- and digest-bound.
- [x] Operations are declarative and reject scripts, commands, and arbitrary paths.
- [x] Resource limits cover context, transcript, visual summaries, cards, review segments, and operations.

## TC-REPO-001: public repository boundary

- [x] Protocol bundle hashing is deterministic.
- [x] Public files contain no internal checkout path, planner/policy package path, Service Token marker, or internal media-directory reference.
- [x] README states incomplete product/release status instead of advertising unavailable commands.

## Next contract gate

The private Server must pin this repository's protocol bundle digest and pass the
same golden vectors before Director policy migration begins.
