# CreatorCut secure whole-tree swap — M1 synthetic prototype

This directory is an isolated, Darwin-only prototype. It is **not wired into
CreatorCut**, is not installed or packaged, and must not be used on a real
project. Its purpose is to make the M0C security design concrete enough for
synthetic crash and adversarial review. Builds and fixtures belong only in a
caller-owned temporary root and are never product artifacts.

The mutating opcodes are compiled in only with `--cfg secure_swap_synthetic`.
A normal build exposes the read-only handshake/capability surface and returns
`Unsupported` for `SWAP_FORWARD` and `RECOVER_FORWARD`.

The source is raw Rust plus one narrow C shim. There is no Cargo manifest and no
third-party crate. A normal build has no test barrier code. A synthetic-only
build may opt in with the rustc cfg `secure_swap_synthetic`; that adds the fixed
inherited-FD 198 barrier ABI described below.

## Threat model and trust boundary

The current model is a **cooperative same-UID** model:

- Trusted: Darwin VFS and durability primitives, a fixed Node 24 caller, the
  immutable helper binary/build ID, its protocol schema, the package-local
  manifest, and the caller that stages and semantically validates canonical
  public metadata.
- Covered: process crash and `SIGKILL`, accidental concurrent writers that all
  honor the same stable lock, a cooperative atomic package updater, symlink and
  special-file substitution, hardlinks, mount crossings, path replacement,
  incomplete/torn WAL records, stale recovery attempts, and unexpected project
  contents.
- Not covered: a malicious process running as the same UID, a compromised
  caller, a helper binary replaced inside a writable installation, kernel or
  storage firmware failure, or a writer that ignores `.creatorcut-control/
writer.lock`. Hostile same-UID protection requires a separately designed
  root-owned installer/service or XPC boundary.

The PROBE challenge binds a response to the expected build and schemas. Because
the session digest is deterministic, it does not prove process identity or
freshness. It is audit material only and is **not** authority to recover, swap,
or choose a project. Recovery authority comes exclusively from a valid, durable
WAL binding plus the exact pre/post filesystem mapping.

## Filesystem model

All transaction paths are project-root siblings:

- active tree: `.creatorcut`
- stable control: `.creatorcut-control`
- stable writer lock: `.creatorcut-control/writer.lock`
- stable WAL directory: `.creatorcut-control/wal`
- stage before swap / quarantine after swap:
  `.creatorcut-swap-<32 lowercase hex tx bytes>`

The control directory, `wal/`, and `writer.lock` must already exist. The helper
does not create directories. The lock is one fail-fast BSD
`flock(LOCK_EX | LOCK_NB)`; a busy lock returns `Conflict` so the fixed caller
can apply a bounded retry deadline. Once acquired it is held from before either
active/stage name is resolved through post-swap verification and durable
`COMMITTED`. After acquisition, the helper repeats the ACL/xattr policy on the
held project parent, root, control directory, WAL directory, and lock file,
then rechecks their descriptor identities and stable names. The pre-lock checks
alone never authorize a mutation. All tree descriptors are read-only. The
writable WAL is closed before the lock-bearing context is dropped.

This prototype deliberately permits only one migration transaction in the
stable namespace: a fresh swap requires an empty `wal/` and exactly its one
stage sibling; recovery requires exactly its one WAL and one stage/quarantine
sibling. Any additional `.creatorcut-swap-*` or WAL entry blocks without
cleanup. Because committed evidence is retained, a later multi-generation
transaction policy is explicitly outside this prototype.

The only tree mutation is:

```text
renameatx_np(rootfd, ".creatorcut", rootfd, stage_name,
             RENAME_SWAP | RENAME_NOFOLLOW_ANY)
```

Both operands are validated as nonempty single components with no slash, NUL,
`.` or `..`, and both resolve below the same already-held directory FD. The
newer `RENAME_RESOLVE_BENEATH` flag is therefore redundant and is deliberately
not used, keeping this synthetic gate buildable on the supported macOS 14 SDK
and kernel as well as newer Darwin releases.

There is no recursive delete, directory removal, leaf replacement, copy
fallback, cleanup, or reverse swap. The old internal tree remains in full at
the stage/quarantine name. WALs, stages, and quarantines are never cleaned by
this helper. The C ABI intentionally exports no destructive primitive.

## External protocol

Every stdin request is one strict big-endian frame:

```text
u32 body_length | body
body := "CCSW" | u16 protocol=1 | u8 opcode | u8 flags=0 | payload
```

Frames shorter than 8 bytes, over 128 KiB, truncated, malformed, or containing
trailing payload bytes are rejected. The root is never read from argv or the
environment. A nonzero 32-byte `PROBE` challenge must be the first frame; the
helper answers before accepting any frame that can contain a root or have a
side effect. Its response echoes the challenge and returns a session digest,
fixed build ID, digest schema, and WAL schema. Every second-frame opcode binds
that session digest, and then the process exits.

The complete external opcode set is:

1. `PROBE` (`1`): challenge handshake only.
2. `CAPABILITIES` (`2`): read-only volume capability query after PROBE.
3. `SWAP_FORWARD` (`3`): one atomic forward transaction.
4. `RECOVER_FORWARD` (`4`): WAL-authorized forward recovery only.

There is deliberately no externally callable prepare/bind opcode and no
rollback, redo, cleanup, generic rename, or arbitrary file operation.

After the common header, request payloads are exactly:

```text
PROBE:            challenge[32]
CAPABILITIES:     session[32] | u16 root_len | root[root_len]
SWAP_FORWARD:     session[32] | tx[16] | project_uuid[16] | nonce[32]
                  | marker_sha256[32] | u64 generation | u32 barrier_mask
                  | u16 root_len | root[root_len]
RECOVER_FORWARD:  session[32] | tx[16] | u32 barrier_mask
                  | u16 root_len | root[root_len]
```

Responses use the same framed common header followed by `u16 status`, `u16
message_len`, a static non-path-bearing error message, then opcode-specific
success bytes. Status zero is success. The helper emits no received root or
project content in a response or error.

Once the swap syscall succeeds, every later error is returned as the distinct
`RecoveryRequired` status. A missing or truncated final response is also
indeterminate even if the process exit status appears successful; callers must
run `RECOVER_FORWARD` for the same tx before any retry.

`SWAP_FORWARD` binds a nonzero tx ID, project UUID, nonce, generation, exact
`storage-authority.json` content digest, and root path. The stage name is derived
from the tx ID rather than supplied. The helper verifies the exact marker bytes
against the requested digest. In this cooperative-TCB prototype the caller is
responsible for proving that the supplied UUID/nonce/generation are the fields
represented by those canonical marker bytes; semantic JSON parsing is not yet
inside the helper.

## Canonical tree digest v2

The digest starts with the domain `CCSW-TREE-DIGEST-V2\0`. It includes the tree
root and every descendant in depth-first traversal with sibling names sorted by
their **original raw name bytes**. Every record binds:

```text
relative name bytes, object type, mode, uid, gid, dev, ino, nlink,
size, st_gen, bounded provenance presence/value digest, and
(for regular files) SHA-256(content)
```

Files are `fstat`ed before and after reading. Named metadata is compared with
the opened FD. Directories are held by FD and checked again after traversal.
The scanner rejects:

- symlinks and every non-directory/non-regular object;
- regular files with `nlink != 1`;
- objects on a different `st_dev`, directory identity cycles, or owner changes;
- group/world-writable objects;
- ACL-bearing objects and every xattr except the host-managed
  `com.apple.provenance`; the accepted attribute is read with a 256-byte cap and
  its absence/presence, exact length, and value are included in every entry
  digest;
- more than 4,096 entries, 64 MiB total regular bytes, a 16 MiB file, depth over
  32, or a relative name over 4,096 bytes.

The active internal tree may contain safe opaque subtrees; every byte and every
accepted object is still included in its digest. The public stage is exact:

- required files: `project.json`, `timeline.json`, `history.json`,
  `operations.jsonl`, `storage-authority.json`, `storage-mutations.jsonl`;
- required `versions/` with canonical `0.json` ... `N.json`, continuous;
- optional files: `transcript.json`, `edit-brief.json`,
  `visual-composition.json`;
- optional fine-cut trio, present as either zero or all three:
  `rough-cut-confirmation.json`, `fine-cut-card-chain.json`, and
  `visual-composition-candidate.json`;
- optional empty `tasks/`.

Any other stage entry is rejected. Media, previews, proxies, generated output,
exports, and `.creatorcut-work` are outside the swapped tree and outside this
helper's authority. Every accepted public metadata file must be valid UTF-8;
full JSON/JSONL schema and cross-file semantic validation remains in the
cooperative caller TCB for this prototype.

## WAL and durability order

Each tx owns `<tx>.wal` in the stable WAL directory. Initial publication uses a
direct `openat(... O_CREAT | O_EXCL | O_APPEND | O_NOFOLLOW, 0600)`: an empty or
partial file left by a crash is retained and blocks; it is never mistaken for a
durable `PREPARED`. The shim also contains a narrow no-clobber
`RENAME_EXCL | RENAME_NOFOLLOW_ANY` wrapper for a future temp-publication
variant, but this prototype does not need or call it. Its operands have the
same strict single-component and same-held-dirfd boundary.

WAL records are append-only and contain a big-endian payload length, CRC-32,
previous record hash, canonical payload, and SHA-256 record hash. The legal
sequence is exactly:

```text
PREPARED -> SWAPPED -> COMMITTED
```

`PREPARED` contains the complete binding: protocol/digest/WAL schemas, fixed
build ID, tx ID, project UUID, root-path digest, direct-parent identity, root
leaf, root dev/ino/uid/mode (plus stronger stat data), active and stage names,
both tree identities/digests, nonce, marker digest, and generation. The helper
holds the parent FD and reopens the absolute root path at mutation boundaries to
re-bind both names to the held root. Later records bind the hash of that exact
binding.

Every phase append is made durable with `fsync(wal_fd)` followed by
`fcntl(wal_fd, F_FULLFSYNC)`, then `fsync(wal_dir_fd)`. Directories never receive
`F_FULLFSYNC`. The forward sequence in one process, under the same stable lock
and the same held root/active/stage FDs, is:

1. bind and digest both trees;
2. open every stage regular file read-write only for `fsync` + `F_FULLFSYNC`,
   sync every stage directory bottom-up, then sync the project root;
3. append and durably sync `PREPARED`;
4. re-bind both names and re-digest held trees immediately before mutation;
5. execute the single atomic whole-tree swap;
6. `fsync(project_root_fd)`;
7. open both resulting names and verify exact post identities/digests;
8. append and durably sync `SWAPPED`;
9. append and durably sync `COMMITTED`;
10. close transaction descriptors, then release the stable flock.

## Forward-only crash matrix

Recovery never guesses and never swaps backward:

| Durable WAL         | Exact mapping under held root FD              | Action                                                                               |
| ------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| no valid `PREPARED` | any                                           | retain everything and block                                                          |
| `PREPARED`          | active=old internal, stage=new public         | repeat checks, swap forward, sync root, verify, append `SWAPPED`, append `COMMITTED` |
| `PREPARED`          | active=new public, stage=old internal         | sync root, verify, append `SWAPPED`, append `COMMITTED`                              |
| `SWAPPED`           | active=new public, stage=old internal         | verify and append `COMMITTED`                                                        |
| `COMMITTED`         | active=new public, stage=old internal         | verify and report committed                                                          |
| any phase           | missing, ambiguous, changed, or third mapping | retain everything and block                                                          |

A crash after the swap syscall but before root fsync is accepted only if the
next run observes one of the two exact bound mappings; the post mapping is then
root-synced and completed forward. A malformed/truncated/checksum-invalid/
hash-chain-invalid WAL authorizes nothing. A challenge authorizes nothing.

## Synthetic deterministic barriers

When and only when compiled with `--cfg secure_swap_synthetic`, a request may
set barrier bits for these points: after durable `PREPARED`, after the swap
syscall but before root fsync, after root fsync, after durable `SWAPPED`, and
after durable `COMMITTED`. The helper writes a fixed binary event containing the
point and tx ID to inherited FD 198, then waits for a matching acknowledgement.
A harness can deliver `SIGKILL` at that deterministic stop. No path, argv item,
or environment variable can select or redirect the hook. Production builds
contain no inherited-FD barrier implementation and reject every nonzero barrier
mask.

## Raw build shape

A future review harness should use a pinned direct Darwin clang, pinned SDK,
and pinned rustc, with output in a fresh synthetic temp root. Conceptually:

```sh
TMPDIR="$NONCE_TMP/compiler-tmp" SDKROOT="$PINNED_MACOS_SDK" \
  "$PINNED_DARWIN_CLANG" -std=c11 -Wall -Wextra -Werror -fno-modules \
  -arch arm64 -isysroot "$PINNED_MACOS_SDK" -c darwin_shim.c \
  -o "$NONCE_TMP/shim.o"
TMPDIR="$NONCE_TMP/compiler-tmp" SDKROOT="$PINNED_MACOS_SDK" \
  "$PINNED_RUSTC" --edition=2021 main.rs \
  -C linker="$PINNED_DARWIN_CLANG" \
  -C link-arg=-isysroot -C link-arg="$PINNED_MACOS_SDK" \
  -C link-arg="$NONCE_TMP/shim.o" -o "$NONCE_TMP/secure-swap"

# Synthetic crash harness build only:
TMPDIR="$NONCE_TMP/compiler-tmp" SDKROOT="$PINNED_MACOS_SDK" \
  "$PINNED_RUSTC" --edition=2021 --cfg secure_swap_synthetic main.rs \
  -C linker="$PINNED_DARWIN_CLANG" \
  -C link-arg=-isysroot -C link-arg="$PINNED_MACOS_SDK" \
  -C link-arg="$NONCE_TMP/shim.o" -o "$NONCE_TMP/secure-swap-synthetic"

TMPDIR="$NONCE_TMP/compiler-tmp" SDKROOT="$PINNED_MACOS_SDK" \
  "$PINNED_DARWIN_CLANG" -std=c11 -Wall -Wextra -Werror -fno-modules \
  -arch arm64 -isysroot "$PINNED_MACOS_SDK" barrier_launcher.c \
  -o "$NONCE_TMP/secure-swap-barrier-launcher"

"$PINNED_NODE_24" harness.mjs \
  --normal-helper "$NONCE_TMP/secure-swap" \
  --synthetic-helper "$NONCE_TMP/secure-swap-synthetic" \
  --barrier-launcher "$NONCE_TMP/secure-swap-barrier-launcher" \
  --temp-root "$NONCE_TMP"
```

Node 24 cannot directly allocate a `child_process` stdio array through index
198 on the verified Darwin host without aborting. The synthetic-only launcher
therefore receives one duplex channel at FD 3, duplicates only that descriptor
to FD 198, and `execve`s the already validated helper with no helper arguments.
It has no product or production role.

The 2026-08-10 isolated checkpoint built all three arm64 binaries with direct
toolchain paths under a deny-network/write-confined sandbox. The retained
harness run passed 37/37 cases, including all five `SIGKILL` barriers, response
loss, forward recovery, malformed WALs, project-parent/root/WAL/stage
replacement, post-`PREPARED` metadata mutation, ACL/xattr, special-file and
lock-contention cases. The standalone SHA-256 suite passed 2/2 and the helper
unit suite passed 3/3. Each retained run copies and hashes the candidate helpers
and reviewed sources instead of pointing only at mutable build paths.

## Known unverified / deliberately incomplete points

- The prototype has not been fuzzed, sanitizer-built, cross-architecture
  tested, packaged, signed, installed, or exercised outside synthetic temp
  fixtures.
- ACL and xattr policy passed pinned-SDK APFS fixtures for no ACL, an explicit
  ACL, the accepted system provenance attribute, and a rejected user xattr.
  Other filesystems and system-managed metadata variants remain unverified and
  fail closed.
- APFS and other intended volumes need capability and crash/power-loss testing;
  process-kill tests are not proof of hardware power-loss durability.
- Marker JSON semantic parsing remains in the cooperative caller TCB. The helper
  binds the provided UUID/nonce/generation and verifies the exact marker digest,
  but does not parse those fields out of JSON itself.
- The public/internal TypeScript writers do not yet acquire this stable lock,
  stage this exact tree, publish the dirty fence for later public mutations, or
  invoke the helper. Runtime loader identity/manifest checks, immutable version
  layout, updater lock, package artifact production, signing, release CI, and
  installed-client validation remain unimplemented.
- There is no real-project authorization. Until integration, final Node 24
  gates, adversarial crash tests, release packaging, and an independent P0/P1
  review all pass, this directory is synthetic evidence only—not M1 completion
  and not production approval.
