import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstatSync, realpathSync, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const LOCK_DIRECTORY = "project.lock";
const RECOVERY_DIRECTORY = "project.lock.recovery";
const CREATING_DIRECTORY = ".creating";
const CURRENT_MUTEX_FILE = "current-mutex.sqlite";
const CURRENT_MUTEX_SIDECAR_SUFFIXES = ["-journal", "-wal", "-shm"] as const;
const PRIORITY_GUARD_UUID = "00000000-0000-0000-0000-000000000000";
const MINIMUM_FROZEN_V1_UUID = "00000000-0000-4000-8000-000000000000";
const MAX_ATTEMPTS = 200;
const INITIALIZATION_GRACE_MS = 250;
const PROCESS_IDENTITY_PROBE_TIMEOUT_MS = 250;
const EXTERNAL_LOCK_WAIT_MS = 2_000;
const SAME_PROCESS_LOCK_WAIT_MS = 15_000;
const execFileAsync = promisify(execFile);
let ownProcessIdentity: Promise<string | null> | null = null;
const heldCurrentMutexes = new Set<string>();

interface LockOwner {
  schema_version: "creatorcut-project-lock/1.0";
  pid: number;
  owner_token: string;
  created_at: string;
}

interface ObservedLockOwner extends LockOwner {
  process_start_identity_digest?: string;
}

interface LegacyLockOwner {
  pid: number;
  created_at: string;
  schema_version?: "creatorcut-project-lock/1.0";
  owner_token?: string;
}

interface Contender {
  name: string;
  path: string;
  owner: ObservedLockOwner | LegacyLockOwner | null;
  birthtimeNs: bigint;
  mtimeMs: number;
}

interface StableLegacyLock {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  contents: string;
}

interface StablePathIdentity {
  dev: bigint;
  ino: bigint;
}

interface SafeCreatingDirectory {
  path: string;
  identity: StablePathIdentity;
  lockDirectory: SafeLockDirectory;
}

interface StagedContender {
  path: string;
  identity: StablePathIdentity;
  creatingDirectory: SafeCreatingDirectory;
}

interface SafeCurrentMutex {
  path: string;
  identity: StablePathIdentity;
  creatingDirectory: SafeCreatingDirectory;
}

type SafeLockDirectory = string & {
  readonly __safeLockDirectory: unique symbol;
};

function samePathIdentity(
  left: StablePathIdentity,
  right: StablePathIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function parseOwner(value: string): LockOwner | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.keys(parsed).sort().join(",") ===
      "created_at,owner_token,pid,schema_version" &&
      parsed.schema_version === "creatorcut-project-lock/1.0" &&
      Number.isSafeInteger(parsed.pid) &&
      Number(parsed.pid) > 0 &&
      typeof parsed.owner_token === "string" &&
      parsed.owner_token.length > 0 &&
      typeof parsed.created_at === "string" &&
      Number.isFinite(Date.parse(parsed.created_at))
      ? (parsed as unknown as LockOwner)
      : null;
  } catch {
    return null;
  }
}

function parseLegacyOwner(value: string): LegacyLockOwner | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const keys = Object.keys(parsed).sort().join(",");
    const supported =
      keys === "created_at,pid" ||
      (keys === "created_at,owner_token,pid,schema_version" &&
        parsed.schema_version === "creatorcut-project-lock/1.0" &&
        typeof parsed.owner_token === "string" &&
        parsed.owner_token.length > 0);
    return supported &&
      Number.isSafeInteger(parsed.pid) &&
      Number(parsed.pid) > 0 &&
      typeof parsed.created_at === "string" &&
      Number.isFinite(Date.parse(parsed.created_at))
      ? (parsed as unknown as LegacyLockOwner)
      : null;
  } catch {
    return null;
  }
}

function hasDefinitelyInvalidPid(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return (
      "pid" in parsed &&
      (!Number.isSafeInteger(parsed.pid) || Number(parsed.pid) <= 0)
    );
  } catch {
    return false;
  }
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function processStartIdentity(pid: number): Promise<string | null> {
  if (!pidIsAlive(pid)) return null;
  if (platform() === "linux") {
    const [statContents, bootId] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ]).catch(() => [null, null] as const);
    if (statContents && bootId) {
      const closing = statContents.lastIndexOf(") ");
      const fields =
        closing >= 0 ? statContents.slice(closing + 2).split(" ") : [];
      const startTicks = fields[19];
      if (startTicks) return `linux:${bootId.trim()}:${startTicks}`;
    }
  }
  if (platform() === "win32") {
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
        ],
        {
          timeout: PROCESS_IDENTITY_PROBE_TIMEOUT_MS,
          windowsHide: true,
        },
      );
      const startTicks = stdout.trim();
      return /^\d+$/u.test(startTicks) ? `windows:${startTicks}` : null;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync(
      "/bin/ps",
      ["-o", "lstart=", "-p", String(pid)],
      {
        timeout: PROCESS_IDENTITY_PROBE_TIMEOUT_MS,
      },
    );
    const startedAt = stdout.trim();
    return startedAt ? `ps:${startedAt}` : null;
  } catch {
    return null;
  }
}

async function ownerIsAlive(
  owner: ObservedLockOwner | LegacyLockOwner | null,
  livenessCache?: Map<string, Promise<boolean>>,
): Promise<boolean> {
  if (!owner || !pidIsAlive(owner.pid)) return false;
  if (!("process_start_identity_digest" in owner)) return true;
  const key = `${owner.pid}:${owner.process_start_identity_digest}`;
  let observed = livenessCache?.get(key);
  if (!observed) {
    observed = (async () => {
      const actual =
        owner.pid === process.pid
          ? await currentProcessStartIdentity()
          : await processStartIdentity(owner.pid);
      return (
        actual === null ||
        processIdentityDigest(actual) === owner.process_start_identity_digest
      );
    })();
    livenessCache?.set(key, observed);
  }
  return observed;
}

async function currentProcessStartIdentity(): Promise<string | null> {
  ownProcessIdentity ??= processStartIdentity(process.pid);
  return ownProcessIdentity;
}

function processIdentityDigest(identity: string | null): string | undefined {
  if (identity === null) return undefined;
  return createHash("sha256").update(identity).digest("hex");
}

function contenderIdentityDigest(
  name: string,
  owner: LockOwner,
): string | undefined {
  const escapedToken = owner.owner_token.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );
  const legacyMatch = new RegExp(
    `^${escapedToken}(?:\\.([a-f0-9]{64}))?\\.json$`,
    "u",
  ).exec(name);
  if (legacyMatch) return legacyMatch[1];
  const currentMatch = new RegExp(
    `^${PRIORITY_GUARD_UUID}\\.${escapedToken}(?:\\.([a-f0-9]{64}))?\\.json$`,
    "u",
  ).exec(name);
  return currentMatch?.[1];
}

function isPriorityGuard(name: string, owner: LockOwner): boolean {
  const escapedToken = owner.owner_token.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );
  return new RegExp(
    `^${PRIORITY_GUARD_UUID}\\.${escapedToken}(?:\\.[a-f0-9]{64})?\\.json$`,
    "u",
  ).test(name);
}

function assertFrozenV1Priority(name: string): void {
  // Frozen v1 uses birthtimeNs and then localeCompare(name). All historical
  // direct names are lowercase RFC 4122 v4 UUIDs. The all-zero UUID prefix is
  // identical through the first two UUID groups and has version nibble 0,
  // which sorts before the frozen v4 nibble 4. The unique suffix is examined
  // only after that decisive position. Runtime-check the active ICU collation
  // too, so an unsupported locale fails closed rather than weakening locking.
  if (
    !name.startsWith(`${PRIORITY_GUARD_UUID}.`) ||
    name.localeCompare(`${MINIMUM_FROZEN_V1_UUID}.json`) >= 0
  ) {
    throw new Error(
      "CreatorCut platform collation cannot preserve frozen-v1 lock priority",
    );
  }
}

function sameLegacyObservation(
  left: StableLegacyLock,
  right: StableLegacyLock,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.contents === right.contents
  );
}

async function readLegacyObservation(
  path: string,
): Promise<StableLegacyLock | null> {
  const info = await stat(path, { bigint: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!info?.isFile()) return null;
  const contents = await readFile(path, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (contents === null) return null;
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
    contents,
  };
}

async function stableLegacyObservation(
  path: string,
): Promise<StableLegacyLock | null> {
  const first = await readLegacyObservation(path);
  if (!first) return null;
  await new Promise((resolveDelay) =>
    setTimeout(resolveDelay, INITIALIZATION_GRACE_MS),
  );
  const second = await readLegacyObservation(path);
  return second && sameLegacyObservation(first, second) ? second : null;
}

async function removeObservedLegacyLock(
  lockPath: string,
  recoveryDirectory: SafeLockDirectory,
  observed: StableLegacyLock,
): Promise<boolean> {
  const quarantine = join(recoveryDirectory, `.legacy-${randomUUID()}.lock`);
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const moved = await readLegacyObservation(quarantine);
  if (moved && sameLegacyObservation(observed, moved)) {
    await rm(quarantine, { force: true });
    return true;
  }
  if ((await pathKind(lockPath)) === null) {
    await rename(quarantine, lockPath);
  }
  throw new Error("CreatorCut legacy lock changed during safe recovery");
}

async function pathKind(path: string): Promise<"directory" | "other" | null> {
  return lstat(path)
    .then((value) => (value.isDirectory() ? "directory" : "other"))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
}

async function canonicalCreatorCutDirectory(path: string): Promise<string> {
  for (const candidate of [dirname(path), path]) {
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TypeError(
        "CreatorCut lock path cannot traverse a symbolic link",
      );
    }
  }
  const canonicalParent = await realpath(dirname(path));
  const canonical = await realpath(path);
  if (dirname(canonical) !== canonicalParent) {
    throw new TypeError("CreatorCut lock root escapes the project directory");
  }
  return canonical;
}

async function checkedLockDirectory(
  root: string,
  name: typeof LOCK_DIRECTORY | typeof RECOVERY_DIRECTORY,
): Promise<SafeLockDirectory> {
  const candidate = resolve(root, name);
  if (dirname(candidate) !== root) {
    throw new TypeError("CreatorCut lock directory escapes project metadata");
  }
  const info = await lstat(candidate);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new TypeError("CreatorCut lock directory must be a local directory");
  }
  const canonical = await realpath(candidate);
  if (canonical !== candidate || dirname(canonical) !== root) {
    throw new TypeError("CreatorCut lock directory escapes project metadata");
  }
  return canonical as SafeLockDirectory;
}

async function createCheckedLockDirectory(
  root: string,
  name: typeof LOCK_DIRECTORY | typeof RECOVERY_DIRECTORY,
): Promise<SafeLockDirectory> {
  const candidate = resolve(root, name);
  try {
    await mkdir(candidate, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return checkedLockDirectory(root, name);
}

async function ensureLockDirectory(
  creatorcutDirectory: string,
): Promise<SafeLockDirectory> {
  const root = await canonicalCreatorCutDirectory(creatorcutDirectory);
  const lockDirectory = join(root, LOCK_DIRECTORY);
  let waits = 0;
  const deadline = Date.now() + MAX_ATTEMPTS * 5;
  const wait = async () => {
    if (waits >= MAX_ATTEMPTS || Date.now() >= deadline) {
      throw new Error(
        "CreatorCut project is locked by another local operation",
      );
    }
    waits += 1;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  };
  for (;;) {
    const lockKind = await pathKind(lockDirectory);
    if (lockKind === null) {
      return createCheckedLockDirectory(root, LOCK_DIRECTORY);
    }
    if (lockKind === "directory") {
      return checkedLockDirectory(root, LOCK_DIRECTORY);
    }
    if ((await lstat(lockDirectory)).isSymbolicLink()) {
      throw new TypeError("CreatorCut lock path cannot be a symbolic link");
    }

    const safeRecovery = await createCheckedLockDirectory(
      root,
      RECOVERY_DIRECTORY,
    );
    const releaseRecovery = await acquireContenderLease(safeRecovery);
    let legacyLive = false;
    try {
      if ((await pathKind(lockDirectory)) === "other") {
        const observed = await stableLegacyObservation(lockDirectory);
        const legacyOwner = observed
          ? (parseOwner(observed.contents) ??
            parseLegacyOwner(observed.contents))
          : null;
        if (
          !observed ||
          (legacyOwner
            ? await ownerIsAlive(legacyOwner)
            : !hasDefinitelyInvalidPid(observed.contents))
        ) {
          legacyLive = true;
        } else {
          await removeObservedLegacyLock(lockDirectory, safeRecovery, observed);
        }
      }
      if (!legacyLive) {
        await mkdir(lockDirectory, { mode: 0o700 }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          },
        );
      }
    } finally {
      await releaseRecovery();
    }
    if (legacyLive) {
      await wait();
      continue;
    }
    if ((await pathKind(lockDirectory)) === "directory") {
      return checkedLockDirectory(root, LOCK_DIRECTORY);
    }
  }
}

async function newOwner(): Promise<{
  wire: LockOwner;
  processStartIdentityDigest?: string;
}> {
  const identity = await currentProcessStartIdentity();
  const identityDigest = processIdentityDigest(identity);
  const wire: LockOwner = {
    schema_version: "creatorcut-project-lock/1.0",
    pid: process.pid,
    owner_token: randomUUID(),
    created_at: new Date().toISOString(),
  };
  return identityDigest
    ? { wire, processStartIdentityDigest: identityDigest }
    : { wire };
}

async function safeCreatingDirectory(
  lockDirectory: SafeLockDirectory,
): Promise<SafeCreatingDirectory> {
  const creatingDirectoryPath = join(lockDirectory, CREATING_DIRECTORY);
  await mkdir(creatingDirectoryPath, { mode: 0o700 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  const creatingInfo = await lstat(creatingDirectoryPath, { bigint: true });
  const creatingDirectory = await realpath(creatingDirectoryPath);
  if (
    creatingInfo.isSymbolicLink() ||
    !creatingInfo.isDirectory() ||
    creatingDirectory !== creatingDirectoryPath ||
    dirname(creatingDirectory) !== lockDirectory
  ) {
    throw new TypeError("CreatorCut contender staging directory must be local");
  }
  return {
    path: creatingDirectory,
    identity: creatingInfo,
    lockDirectory,
  };
}

async function safeCurrentMutexPath(
  creatingDirectory: SafeCreatingDirectory,
): Promise<SafeCurrentMutex> {
  const mutexPath = join(creatingDirectory.path, CURRENT_MUTEX_FILE);
  try {
    const handle = await open(mutexPath, "wx", 0o600);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const sidecars = CURRENT_MUTEX_SIDECAR_SUFFIXES.map(
    (suffix) => `${mutexPath}${suffix}`,
  );
  const [reboundCreating, mutexInfo, canonicalMutex] = await Promise.all([
    lstat(creatingDirectory.path, { bigint: true }),
    lstat(mutexPath, { bigint: true }),
    realpath(mutexPath),
  ]);
  const sidecarStates = await Promise.all(
    sidecars.map((sidecar) =>
      lstat(sidecar, { bigint: true })
        .then(() => true)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        }),
    ),
  );
  if (
    !reboundCreating.isDirectory() ||
    !samePathIdentity(creatingDirectory.identity, reboundCreating) ||
    !privatePosixMetadata(reboundCreating) ||
    mutexInfo.isSymbolicLink() ||
    !mutexInfo.isFile() ||
    mutexInfo.nlink !== 1n ||
    mutexInfo.size !== 0n ||
    mutexInfo.dev !== reboundCreating.dev ||
    !privatePosixMetadata(mutexInfo) ||
    sidecarStates.some(Boolean) ||
    canonicalMutex !== mutexPath ||
    dirname(canonicalMutex) !== creatingDirectory.path
  ) {
    throw new TypeError("CreatorCut current mutex path failed security checks");
  }
  return {
    path: mutexPath,
    identity: mutexInfo,
    creatingDirectory,
  };
}

function privatePosixMetadata(
  info: Pick<BigIntStats, "mode" | "uid">,
): boolean {
  // Node does not implement owner/group/other permission distinctions on
  // Windows. Windows therefore relies on the inherited project ACL and the
  // cooperative same-user contract; POSIX hosts require owner-only metadata.
  if (platform() === "win32") return true;
  if (typeof process.getuid !== "function") return false;
  return info.uid === BigInt(process.getuid()) && (info.mode & 0o077n) === 0n;
}

function verifyCurrentMutexStillSafe(mutex: SafeCurrentMutex): void {
  const reboundCreating = lstatSync(mutex.creatingDirectory.path, {
    bigint: true,
  });
  const mutexInfo = lstatSync(mutex.path, { bigint: true });
  const canonicalMutex = realpathSync(mutex.path);
  const sidecarExists = CURRENT_MUTEX_SIDECAR_SUFFIXES.some((suffix) => {
    try {
      lstatSync(`${mutex.path}${suffix}`, { bigint: true });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  });
  if (
    !reboundCreating.isDirectory() ||
    !samePathIdentity(mutex.creatingDirectory.identity, reboundCreating) ||
    !privatePosixMetadata(reboundCreating) ||
    mutexInfo.isSymbolicLink() ||
    !mutexInfo.isFile() ||
    mutexInfo.nlink !== 1n ||
    mutexInfo.size !== 0n ||
    mutexInfo.dev !== reboundCreating.dev ||
    !samePathIdentity(mutex.identity, mutexInfo) ||
    !privatePosixMetadata(mutexInfo) ||
    sidecarExists ||
    canonicalMutex !== mutex.path ||
    dirname(canonicalMutex) !== mutex.creatingDirectory.path
  ) {
    throw new TypeError("CreatorCut current mutex path failed security checks");
  }
}

function sqliteBusy(error: unknown): boolean {
  const sqliteError = error as {
    code?: unknown;
    errcode?: unknown;
    message?: unknown;
  };
  return (
    sqliteError.errcode === 5 ||
    sqliteError.errcode === 6 ||
    (sqliteError.code === "ERR_SQLITE_ERROR" &&
      typeof sqliteError.message === "string" &&
      /\b(?:busy|locked)\b/iu.test(sqliteError.message))
  );
}

function tryBeginCurrentMutex(mutex: SafeCurrentMutex): DatabaseSync | null {
  // Do not depend on platform-specific SQLite/POSIX behavior for two
  // connections in one process. The JavaScript event loop makes this check and
  // the synchronous BEGIN/add sequence an atomic module-local handoff.
  if (heldCurrentMutexes.has(mutex.path)) return null;
  const database = new DatabaseSync(mutex.path, {
    allowExtension: false,
    enableForeignKeyConstraints: false,
    timeout: 0,
  });
  try {
    verifyCurrentMutexStillSafe(mutex);
    const journalMode = database.prepare("PRAGMA journal_mode=MEMORY").get() as
      Record<string, unknown> | undefined;
    if (journalMode?.journal_mode !== "memory") {
      throw new TypeError(
        "CreatorCut current mutex could not disable filesystem sidecars",
      );
    }
    verifyCurrentMutexStillSafe(mutex);
    database.exec("BEGIN IMMEDIATE");
    verifyCurrentMutexStillSafe(mutex);
    heldCurrentMutexes.add(mutex.path);
    return database;
  } catch (error) {
    database.close();
    if (sqliteBusy(error)) return null;
    throw error;
  }
}

function releaseCurrentMutex(
  mutex: SafeCurrentMutex,
  database: DatabaseSync,
): void {
  let failure: unknown;
  try {
    verifyCurrentMutexStillSafe(mutex);
    database.exec("ROLLBACK");
  } catch (error) {
    failure = error;
  }
  try {
    database.close();
  } catch (error) {
    failure ??= error;
  } finally {
    heldCurrentMutexes.delete(mutex.path);
  }
  try {
    verifyCurrentMutexStillSafe(mutex);
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
}

async function createStagedContender(
  creatingDirectory: SafeCreatingDirectory,
  owner: LockOwner,
): Promise<StagedContender> {
  const temporary = join(
    creatingDirectory.path,
    `.creating-${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  let temporaryIdentity: StablePathIdentity | null = null;
  try {
    await handle.writeFile(JSON.stringify(owner), "utf8");
    await handle.sync();
    const written = await handle.stat({ bigint: true });
    if (!written.isFile() || written.nlink !== 1n) {
      throw new TypeError(
        "CreatorCut contender staging file must be a private regular file",
      );
    }
    temporaryIdentity = written;
    await handle.close();

    const [reboundCreating, reboundTemporary] = await Promise.all([
      lstat(creatingDirectory.path, { bigint: true }),
      lstat(temporary, { bigint: true }),
    ]);
    if (
      !reboundCreating.isDirectory() ||
      !samePathIdentity(creatingDirectory.identity, reboundCreating) ||
      !reboundTemporary.isFile() ||
      reboundTemporary.nlink !== 1n ||
      !samePathIdentity(written, reboundTemporary)
    ) {
      throw new Error(
        "CreatorCut contender staging identity changed before publish",
      );
    }
  } catch (error) {
    // A pathname cleanup cannot safely prove the parent/leaf binding after an
    // adversarial replacement. Retain the hidden staging file for inspection.
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }

  if (!temporaryIdentity) {
    throw new Error("CreatorCut contender staging identity is unavailable");
  }
  return {
    path: temporary,
    identity: temporaryIdentity,
    creatingDirectory,
  };
}

async function publishPriorityGuard(
  staged: StagedContender,
  owner: LockOwner,
  processStartIdentityDigest?: string,
): Promise<string> {
  // The final pathname is generated only after the complete inode is durable.
  // The all-zero UUID prefix is reserved to current writers and the owner token
  // makes the full pathname unique, so no fixed generation can be replaced by
  // a later writer. The SQLite transaction serializes all cooperating current
  // publishers; frozen v1 writers only use raw UUID names and cannot collide.
  const name = `${PRIORITY_GUARD_UUID}.${owner.owner_token}${
    processStartIdentityDigest ? `.${processStartIdentityDigest}` : ""
  }.json`;
  assertFrozenV1Priority(name);
  const path = join(staged.creatingDirectory.lockDirectory, name);
  if ((await pathKind(path)) !== null) {
    throw new Error("CreatorCut current contender pathname already exists");
  }
  const [reboundCreating, reboundTemporary] = await Promise.all([
    lstat(staged.creatingDirectory.path, { bigint: true }),
    lstat(staged.path, { bigint: true }),
  ]);
  if (
    !reboundCreating.isDirectory() ||
    !samePathIdentity(staged.creatingDirectory.identity, reboundCreating) ||
    !reboundTemporary.isFile() ||
    reboundTemporary.nlink !== 1n ||
    !samePathIdentity(staged.identity, reboundTemporary)
  ) {
    throw new Error(
      "CreatorCut contender staging identity changed before publish",
    );
  }
  await rename(staged.path, path);
  return path;
}

async function verifyPublishedPriorityGuard(
  staged: StagedContender,
  publishedPath: string,
): Promise<void> {
  const [publishedCreating, publishedContender] = await Promise.all([
    lstat(staged.creatingDirectory.path, { bigint: true }),
    lstat(publishedPath, { bigint: true }),
  ]);
  if (
    !publishedCreating.isDirectory() ||
    !samePathIdentity(staged.creatingDirectory.identity, publishedCreating) ||
    !publishedContender.isFile() ||
    publishedContender.nlink !== 1n ||
    !samePathIdentity(staged.identity, publishedContender)
  ) {
    throw new Error("CreatorCut contender identity changed during publish");
  }
}

async function contenders(
  lockDirectory: SafeLockDirectory,
): Promise<Contender[]> {
  const values: Contender[] = [];
  for (const name of await readdir(lockDirectory)) {
    if (!name.endsWith(".json")) continue;
    const path = join(lockDirectory, name);
    const info = await stat(path, { bigint: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (!info?.isFile()) continue;
    const owner = await readFile(path, "utf8")
      .then((value) => parseOwner(value) ?? parseLegacyOwner(value))
      .catch(() => null);
    const versionedOwner =
      owner?.schema_version === "creatorcut-project-lock/1.0" &&
      typeof owner.owner_token === "string"
        ? (owner as LockOwner)
        : null;
    const identityDigest = versionedOwner
      ? contenderIdentityDigest(name, versionedOwner)
      : undefined;
    const observedOwner = versionedOwner
      ? {
          ...versionedOwner,
          ...(identityDigest
            ? { process_start_identity_digest: identityDigest }
            : {}),
        }
      : owner;
    values.push({
      name,
      path,
      owner: observedOwner,
      birthtimeNs: info.birthtimeNs,
      mtimeMs: Number(info.mtimeMs),
    });
  }
  return values.sort((left, right) =>
    left.birthtimeNs === right.birthtimeNs
      ? left.name.localeCompare(right.name)
      : left.birthtimeNs < right.birthtimeNs
        ? -1
        : 1,
  );
}

async function contenderIsLive(contender: Contender): Promise<boolean> {
  if (contender.owner) return ownerIsAlive(contender.owner);
  return true;
}

async function removeAbandonedContenders(
  values: Contender[],
  livenessCache?: Map<string, Promise<boolean>>,
): Promise<boolean[]> {
  const live = await Promise.all(
    values.map((contender) =>
      contender.owner
        ? ownerIsAlive(contender.owner, livenessCache)
        : contenderIsLive(contender),
    ),
  );
  for (const [index, contender] of values.entries()) {
    if (!live[index]) {
      // Frozen-v1 raw UUIDs and current priority guards are generation-unique.
      // This implementation never recreates the retired active.json prototype,
      // so cleaning one observed dead instance cannot delete a new generation.
      await rm(contender.path, { force: true });
    }
  }
  return live;
}

function sameProcessOwner(
  blockingOwner: Contender["owner"],
  owner: LockOwner,
  processStartIdentityDigest?: string,
): boolean {
  return (
    blockingOwner?.pid === owner.pid &&
    (("process_start_identity_digest" in blockingOwner &&
      blockingOwner.process_start_identity_digest ===
        processStartIdentityDigest) ||
      (!("process_start_identity_digest" in blockingOwner) &&
        processStartIdentityDigest === undefined))
  );
}

async function waitForLock(
  sameProcess: boolean,
  externalDeadline: number,
  sameProcessDeadline: number,
): Promise<void> {
  const deadline = sameProcess ? sameProcessDeadline : externalDeadline;
  if (Date.now() >= deadline) {
    throw new Error("CreatorCut project is locked by another local operation");
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
}

async function liveContenders(
  lockDirectory: SafeLockDirectory,
  livenessCache: Map<string, Promise<boolean>>,
): Promise<Contender[]> {
  const observed = await contenders(lockDirectory);
  const liveStates = await removeAbandonedContenders(observed, livenessCache);
  return observed.filter((_, index) => liveStates[index]);
}

async function acquireContenderLease(
  lockDirectory: SafeLockDirectory,
): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  const externalDeadline = startedAt + EXTERNAL_LOCK_WAIT_MS;
  const sameProcessDeadline = startedAt + SAME_PROCESS_LOCK_WAIT_MS;
  const livenessCache = new Map<string, Promise<boolean>>();
  const owned = await newOwner();
  const owner = owned.wire;
  const creatingDirectory = await safeCreatingDirectory(lockDirectory);
  const mutex = await safeCurrentMutexPath(creatingDirectory);
  let database: DatabaseSync | null = null;
  let ownPath: string | null = null;
  try {
    while (!database) {
      database = tryBeginCurrentMutex(mutex);
      if (!database) {
        await waitForLock(
          heldCurrentMutexes.has(mutex.path),
          externalDeadline,
          sameProcessDeadline,
        );
      }
    }

    // SQLite is invisible to frozen v1 and only serializes current writers.
    // Before publishing our v1-visible guard, drain every existing direct
    // contender. A frozen writer can still arrive in the final scan/publish
    // window, so publication is followed by a second, stronger sole-live test.
    for (;;) {
      const live = await liveContenders(lockDirectory, livenessCache);
      if (live.length === 0) break;
      await waitForLock(
        sameProcessOwner(
          live[0]?.owner ?? null,
          owner,
          owned.processStartIdentityDigest,
        ),
        externalDeadline,
        sameProcessDeadline,
      );
    }

    const staged = await createStagedContender(creatingDirectory, owner);
    ownPath = await publishPriorityGuard(
      staged,
      owner,
      owned.processStartIdentityDigest,
    );
    await verifyPublishedPriorityGuard(staged, ownPath);

    for (;;) {
      const live = await liveContenders(lockDirectory, livenessCache);
      const ownGuard = live.find(
        (contender) =>
          contender.path === ownPath &&
          contender.owner?.owner_token === owner.owner_token,
      );
      if (
        !ownGuard ||
        !ownGuard.owner ||
        !("owner_token" in ownGuard.owner) ||
        !isPriorityGuard(ownGuard.name, ownGuard.owner as LockOwner)
      ) {
        throw new Error("CreatorCut current contender identity changed");
      }
      if (live.length === 1 && live[0]?.path === ownPath) {
        const acquiredDatabase = database;
        database = null;
        const acquiredPath = ownPath;
        ownPath = null;
        return async () => {
          let failure: unknown;
          try {
            // No project mutation occurs after the visible guard is removed.
            await rm(acquiredPath, { force: true });
          } catch (error) {
            failure = error;
          }
          try {
            releaseCurrentMutex(mutex, acquiredDatabase);
          } catch (error) {
            failure ??= error;
          }
          if (failure) throw failure;
        };
      }

      // A frozen writer can publish and even enter between our empty pre-scan
      // and atomic guard rename. Its unique raw contender remains visible until
      // its operation releases, so requiring our guard to be the sole live file
      // closes that handoff. Later frozen writers see the priority guard and
      // eventually time out; a sustained stream may make this current attempt
      // fail closed, deliberately trading mixed-version availability for safety.
      const blocker = live.find((contender) => contender.path !== ownPath);
      await waitForLock(
        sameProcessOwner(
          blocker?.owner ?? null,
          owner,
          owned.processStartIdentityDigest,
        ),
        externalDeadline,
        sameProcessDeadline,
      );
    }
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    if (ownPath) {
      await rm(ownPath, { force: true }).catch((cleanupError) => {
        cleanupFailures.push(cleanupError);
      });
    }
    if (database) {
      try {
        releaseCurrentMutex(mutex, database);
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "CreatorCut lock acquisition failed and cleanup was incomplete",
        { cause: error },
      );
    }
    throw error;
  }
}

export async function withCreatorCutProjectLock<T>(
  creatorcutDirectory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockDirectory = await ensureLockDirectory(creatorcutDirectory);
  const release = await acquireContenderLease(lockDirectory);
  try {
    return await operation();
  } finally {
    await release();
  }
}
