# Cycle 4 managed release closeout

- Date: 2026-07-27
- Public implementation: `AgentMesh-CreatorCut main@297f870`
- Core implementation: `agentmesh-core main@b63389d`
- State: local Cycle 4 engineering complete; Cycle 5 is next

## Boundary

This checkpoint implements release governance without activating a release.
It did not push, create a GitHub tag or Release, configure a real CreatorCut
ReleaseManifest, inject production signing material, deploy, run a production
canary or publish an installation command.

The public repository owns installer, verifier, updater and local execution.
Core owns official product-keyed version policy and server-side signing. The
private CreatorCut Server is unchanged. Internal CreatorCut and
AgentMesh360-Client are not runtime dependencies.

## Implemented

Core:

- product-keyed release metadata and signing-key registries;
- signing seeds separated from reviewable metadata;
- backward-compatible Job Agent fallback;
- exact `/v1/products/creatorcut/client-release` endpoint;
- fail-closed 503 until a real RC is configured;
- signed/tamper-evident and secret-boundary tests.

Public client:

- standalone bootstrap verifier for recovery-root keyset and Core manifest;
- macOS installer with Node 24, FFmpeg, FFprobe, whisper.cpp and model checks;
- exact tag, commit and canonical archive SHA-256 verification before release
  code execution;
- managed metadata, shim and local release trust files;
- `version`, `update check`, `update apply` and `upgrade-check`;
- task-aware update deferral, official-origin and clean-worktree gates;
- monotonic release-keyset floor;
- build/smoke rollback to the previous commit.

## Verification

Public Node 24 full `pnpm verify`:

- formatting, typecheck and build passed;
- 78 Vitest cases passed;
- 15 Node public-contract cases passed;
- the clean macOS fixture created an isolated tagged source repository, served
  a signed Core manifest on loopback, installed without an internal CreatorCut
  checkout, and verified the final shim plus managed commit/archive metadata;
- a tampered standalone manifest was rejected before checkout.

Core:

- CreatorCut/Job Agent release and commercial contract subset: 13 passed;
- full suite: 264 passed, 3 skipped;
- Ruff and `git diff --check` passed.

No secrets, user media, user transcript, credits or external accounts were used.
The clean fixture contains only synthetic source and signing keys.

## Completion interpretation

Cycle 4 is closed because the frozen install/update contracts and clean
tag/archive fixture passed. A real GitHub RC tag and public-channel reinstall
remain Cycle 5 by the authoritative plan, so this closeout must not be cited as
public-release evidence.

Kimi CLI could not provide a new Cycle 4 verdict because the existing Kimi Code
provider returned its billing-cycle quota error before reading the delta. No
replacement reviewer or fabricated verdict is claimed. The final M1 public
launch gate still requires the independent Kimi review when that provider is
available.
