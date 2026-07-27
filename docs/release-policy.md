# CreatorCut managed release policy

## Current scope

CreatorCut M1 managed installation supports macOS only. The frozen runtime is:

- Node.js 24 and pnpm 10;
- FFmpeg and FFprobe from the same auditable installation;
- an executable whisper.cpp CLI;
- a local whisper model selected by the user or deployment and recorded in
  managed metadata.

The installer does not silently download an unpinned model. A missing component
stops with a recoverable command or an explicit environment variable to set.
Linux and Windows remain unsupported until equivalent media, keychain,
installer, updater and voice-path validation exists.

The default install root is `~/.local/share/creatorcut`. The executable shim is
`~/.local/bin/creatorcut`. Project state remains in each project’s
`.creatorcut` directory and is never placed inside the managed source checkout.

## Trust chain

The release trust chain is independent of the Director artifact trust chain:

1. The public client pins offline CreatorCut Release recovery-root public keys.
2. A recovery root signs a purpose=`release` keyset with a monotonic version,
   validity window and current/previous/revoked online keys.
3. AgentMesh Core signs a product-keyed ReleaseManifest using a current online
   Release key.
4. The client verifies the keyset and manifest before fetching or executing
   release code.
5. The signed tag must resolve to the signed commit, and the canonical
   `git archive --format=tar` SHA-256 must equal the manifest digest.

The client rejects keyset rollback, an unknown/revoked/inactive signing key,
unexpected fields, product/channel/protocol mismatch, malformed versions,
tag/commit/digest mismatch and invalid signature. Core unavailability does not
fall back to GitHub “latest”.

Key rotation is two-phase: first ship a recovery-root-signed keyset containing
the new current key and the old previous key; only after that keyset is accepted
may Core sign a ReleaseManifest with the new key. Revocation ships in a higher
keyset version. Key IDs are never reused. Director and Release rotations do not
change one another.

Initial trust material is generated with `pnpm release:generate-trust` after
the Protocol package is built. The command requires an absolute private output
directory outside the public repository, refuses to overwrite any existing
material, writes private files with mode `0600`, and emits only public file
digests. The recovery private key remains offline; only the online Release seed
is injected into Core's server-only signing-key registry.

## Core authority

Core stores public release metadata in `CLIENT_RELEASE_REGISTRY_JSON`, keyed by
product. Ed25519 seeds are injected separately through the server-only
`CLIENT_RELEASE_SIGNING_KEYS_JSON`, keyed by signing key ID. A private seed in
the public metadata registry is rejected.

`GET /v1/products/creatorcut/client-release` returns 503 until all real release
fields exist. It is configured only after the public RC tag, commit, canonical
archive SHA-256 and notes are immutable. The public repository is the release
carrier; Core is the official version-policy authority.

The legacy Job Agent fields remain a compatibility fallback while Job Agent is
migrated to the same product-keyed registry. CreatorCut does not copy or fork a
second Job-Agent-specific registry.

## Managed commands

- `creatorcut version` reports the installed public client version.
- `creatorcut update check` fetches and verifies Core’s signed policy.
- `creatorcut upgrade-check --project <path>` validates project readability,
  lists preserved state and reports active tasks.
- `creatorcut update apply --project <path>` updates only a verified managed
  install.

Queued, running or finalizing transcription/export tasks defer an update.
Tracked changes in the managed checkout, a non-official origin, a concurrent
update lock or a lower keyset version also stop it.

Update checks out the exact signed commit, rebuilds dependencies, then runs a
version smoke. If build or smoke fails, the updater restores the prior detached
commit and prior dependency build. Project media, `.creatorcut` state, Director
session, history, task checkpoints and user choices are untouched.

## Release activation order

Cycle 4 proves the contracts with an isolated signed tag fixture. Cycle 5 owns
the real activation sequence:

1. create and validate RC signing material without committing private keys;
2. freeze public RC commit/tag/archive and notes;
3. configure the Core RC ReleaseManifest;
4. install through the public channel and run full staging dogfood;
5. freeze stable immutable artifacts;
6. deploy Server/Core/shared Caddy in dark/gated mode;
7. perform approved paid canary and rollback drill;
8. activate Core stable ReleaseManifest last;
9. reinstall from the public channel and run the production smoke.

No local test, local `main`, installer file, Core endpoint implementation or
clean fixture is itself a public release.
