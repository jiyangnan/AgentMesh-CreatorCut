import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { homedir, platform } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import { digestJcs } from "@agentmesh/creatorcut-protocol";

import { validateLocalArtifact } from "./artifact-schema.js";
import { withCreatorCutProjectLock } from "./project-lock.js";
import type {
  AuthorityMigrationFailureStage,
  LocalEditBrief,
  LocalMediaProject,
  LocalOperationLogEntry,
  LocalProjectSnapshot,
  LocalRevisionHistory,
  LocalTimeline,
  LocalTranscript,
  LocalVisualComposition,
  MigrateLegacyInternalProjectInput,
  MigratedVisualHandoffVerification,
  PublicMutationFailureStage,
  StorageAuthorityMarker,
  StorageAuthorityMigrationResult,
} from "./types.js";

const AUTHORITY_FILE = "storage-authority.json";
const MUTATION_JOURNAL_FILE = "storage-mutations.jsonl";
const PENDING_FILE = "pending-authority-migration.json";
const PUBLIC_MUTATION_PENDING_FILE = "pending-public-mutation.json";
const INTERNAL_TRANSACTION_FILE = "pending-transaction.json";
const LEGACY_HEAD_FILE = "head.json";
const LOCK_FILE = "project.lock";
const LOCK_RECOVERY_DIRECTORY = "project.lock.recovery";
const STAGING_DIRECTORY = ".authority-migration";
const MUTATION_STAGING_DIRECTORY = ".public-mutation";
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const LEGACY_PRIVATE_STATE_FILES = [
  LEGACY_HEAD_FILE,
  "m1-1-dogfood-report.json",
  "import-source.json",
  "studio.json",
] as const;
const PUBLIC_ADOPTION_BLOCKERS = [
  PENDING_FILE,
  PUBLIC_MUTATION_PENDING_FILE,
  INTERNAL_TRANSACTION_FILE,
  STAGING_DIRECTORY,
  MUTATION_STAGING_DIRECTORY,
  "preview-confirmation.json",
  "director-state.json",
  ...LEGACY_PRIVATE_STATE_FILES,
] as const;
const RETAINED_RUNTIME_DIRECTORIES = new Set([
  "generated",
  "previews",
  "tasks/transcription-work",
]);
const LEGACY_ADOPTION_TASK_PATHS = new Set([
  "tasks/import.json",
  "tasks/export.json",
  "tasks/export-locator.json",
  "tasks/transcription.json",
  "tasks/transcription-locator.json",
]);
const NON_TRANSFERRED_RUNTIME_ARTIFACTS = [
  "director-consent.json",
  "director-state.json",
  "preview-confirmation.json",
] as const;

interface MetadataBackupFile {
  relative_path: string;
  sha256: string;
  size_bytes: number;
}

interface MetadataBackupManifest {
  schema_version: "creatorcut-metadata-backup/1.0";
  project_id: string;
  project_revision: number;
  created_at: string;
  files: MetadataBackupFile[];
}

interface MetadataTreeManifest {
  schema_version: "creatorcut-metadata-tree/1.1";
  files_digest: string;
  files: MetadataBackupFile[];
}

type LegacyCompatibleOperationLogEntry = Omit<
  LocalOperationLogEntry,
  "kind"
> & {
  kind?: LocalOperationLogEntry["kind"];
};

interface AuthorityStageManifest {
  schema_version: "creatorcut-authority-stage/1.1";
  migration_id: string;
  project_id: string;
  revision: number;
  source_files_digest: string;
  files_digest: string;
  files: MetadataBackupFile[];
}

type VerifiedAuthorityStage = AuthorityStageManifest & {
  contents: ReadonlyMap<string, Buffer>;
  rollback: VerifiedMetadataBackup;
};

interface VerifiedMetadataBackup {
  manifest: MetadataBackupManifest;
  contents: ReadonlyMap<string, Buffer>;
}

interface TrustedDirectoryIdentity {
  path: string;
  handle: FileHandle;
  dev: bigint;
  ino: bigint;
}

interface LegacySnapshot {
  schema_version: "1.0-alpha";
  project: LocalMediaProject;
  timeline: LocalTimeline;
  transcript?: LocalTranscript;
  edit_brief?: LocalEditBrief;
  visual_composition?: LocalVisualComposition;
  restored_from_revision?: number;
}

interface LegacyHead {
  schema_version: "1.0-alpha";
  snapshot: LegacySnapshot;
  history: {
    schema_version: "1.0-alpha";
    current_revision: number;
    undo_stack: number[];
    redo_stack: number[];
  };
}

interface LegacyOperationRecord {
  transaction_id: string;
  kind: "commit" | "undo" | "redo";
  base_revision: number;
  resulting_revision: number;
  committed_at: string;
  operations?: Array<{ operation_id?: string }>;
  restored_from_revision?: number;
}

interface PendingAuthorityMigration {
  schema_version: "creatorcut-authority-migration/1.1";
  direction: "to_public" | "rollback_to_internal";
  phase: "source_locked" | "staged" | "installing" | "rollback_locked";
  migration_id: string;
  project_id: string;
  revision: number;
  backup_manifest_digest: string;
  source_manifest_digest: string;
  stage_files_digest: string | null;
  created_at: string;
}

interface PendingPublicMutation {
  schema_version: "creatorcut-public-mutation/1.1";
  transaction_id: string;
  project_id: string;
  base_revision: number;
  base_generation: number;
  expected_generation: number;
  base_canonical_state_digest: string;
  before_snapshot_digest: string;
  mutation_kind: string;
  created_at: string;
}

interface StorageMutationJournalEntry {
  schema_version: "creatorcut-storage-mutation/1.0";
  generation: number;
  migration_id: string;
  project_id: string;
  mutation_kind: string;
  project_revision: number;
  canonical_state_digest: string;
  committed_at: string;
}

type SafeCleanupDirectory = string & {
  readonly __safeCleanupDirectory: unique symbol;
};

const MARKER_KEYS = [
  "schema_version",
  "authority",
  "generation",
  "handoff_generation",
  "migration_id",
  "project_id",
  "adopted_revision",
  "current_revision",
  "source_format",
  "backup_manifest_digest",
  "handoff_source_files_digest",
  "handoff_stage_files_digest",
  "canonical_state_digest",
  "activated_at",
  "updated_at",
] as const;

const PENDING_KEYS = [
  "schema_version",
  "direction",
  "phase",
  "migration_id",
  "project_id",
  "revision",
  "backup_manifest_digest",
  "source_manifest_digest",
  "stage_files_digest",
  "created_at",
] as const;

const PUBLIC_MUTATION_PENDING_KEYS = [
  "schema_version",
  "transaction_id",
  "project_id",
  "base_revision",
  "base_generation",
  "expected_generation",
  "base_canonical_state_digest",
  "before_snapshot_digest",
  "mutation_kind",
  "created_at",
] as const;

const STORAGE_MUTATION_JOURNAL_KEYS = [
  "schema_version",
  "generation",
  "migration_id",
  "project_id",
  "mutation_kind",
  "project_revision",
  "canonical_state_digest",
  "committed_at",
] as const;

const BACKUP_ROOT_JSON = new Set([
  "project.json",
  "timeline.json",
  "transcript.json",
  "edit-brief.json",
  "history.json",
  "head.json",
  "visual-composition.json",
  "visual-composition-candidate.json",
  "fine-cut-card-chain.json",
  "rough-cut-confirmation.json",
  "m1-1-dogfood-report.json",
  "import-source.json",
  "studio.json",
  "director-consent.json",
  "director-state.json",
  "preview-confirmation.json",
  AUTHORITY_FILE,
]);
const BACKUP_ROOT_JSONL = new Set(["operations.jsonl", MUTATION_JOURNAL_FILE]);
const PUBLIC_MANAGED_ROOT = new Set([
  "project.json",
  "timeline.json",
  "transcript.json",
  "edit-brief.json",
  "history.json",
  "visual-composition.json",
  "visual-composition-candidate.json",
  "fine-cut-card-chain.json",
  "rough-cut-confirmation.json",
  "director-consent.json",
  "director-state.json",
  "preview-confirmation.json",
  "operations.jsonl",
]);

function digest(contents: Buffer | string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 digest`);
  }
}

function assertIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
}

function assertIsoDate(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, i) => key !== wanted[i])
  ) {
    throw new TypeError(`${label} has unsupported or missing fields`);
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  allowed: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  const missing = required.filter((key) => !actual.includes(key));
  const unknown = actual.filter((key) => !allowed.includes(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new TypeError(`${label} has unsupported or missing fields`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function containedChild(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot.length > 0 &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

async function pathExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    try {
      await handle.sync();
    } catch (error) {
      // Node's Windows backend cannot flush a directory handle. Every staged
      // file is synced before rename; process-crash recovery remains covered,
      // while sudden-power-loss durability is explicitly outside this RC.
      if (
        platform() !== "win32" ||
        (error as NodeJS.ErrnoException).code !== "EPERM"
      ) {
        throw error;
      }
    }
  } finally {
    await handle.close();
  }
}

async function syncDirectoryTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new TypeError(
        "Durable metadata tree cannot contain symbolic links",
      );
    }
    if (entry.isDirectory()) await syncDirectoryTree(join(root, entry.name));
  }
  await syncDirectory(root);
}

async function durableMkdir(path: string): Promise<void> {
  const absolute = resolve(path);
  const missing: string[] = [];
  let cursor = absolute;
  for (;;) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new TypeError(`Durable directory path is unsafe: ${cursor}`);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.unshift(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new TypeError(`Durable directory root is unavailable: ${path}`);
      }
      cursor = parent;
    }
  }
  for (const directory of missing) {
    await mkdir(directory, { mode: 0o700 });
    await syncDirectory(dirname(directory));
    await syncDirectory(directory);
  }
}

async function atomicPrivateBuffer(
  path: string,
  contents: Buffer,
): Promise<void> {
  const parent = dirname(path);
  await durableMkdir(parent);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(parent);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

const ATOMIC_TEMP_NAME =
  /^(.+)\.([1-9]\d*)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tmp$/u;
const LEGACY_ATOMIC_TEMP_NAME = /^(.+)\.([1-9]\d*)\.tmp$/u;
const ARTIFACT_ATOMIC_TEMP_NAME =
  /^\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.artifact\.tmp$/u;

function isRecoverableAtomicTarget(relativePath: string): boolean {
  if (relativePath.startsWith("tasks/")) {
    return LEGACY_ADOPTION_TASK_PATHS.has(relativePath);
  }
  return (
    isAllowedMetadataPath(relativePath, "transaction") ||
    relativePath === PENDING_FILE ||
    relativePath === PUBLIC_MUTATION_PENDING_FILE
  );
}

function abandonedAtomicTarget(
  relativePath: string,
): { target: string; pid: number | null } | null {
  const artifactLeaf = relativePath.startsWith("tasks/")
    ? relativePath.slice("tasks/".length)
    : relativePath.includes("/")
      ? null
      : relativePath;
  if (artifactLeaf !== null && ARTIFACT_ATOMIC_TEMP_NAME.test(artifactLeaf)) {
    return {
      target: relativePath.startsWith("tasks/") ? "tasks/*" : "root-artifact/*",
      pid: null,
    };
  }
  const separator = relativePath.lastIndexOf("/");
  const prefix = separator < 0 ? "" : relativePath.slice(0, separator + 1);
  const leaf = separator < 0 ? relativePath : relativePath.slice(separator + 1);
  const match =
    ATOMIC_TEMP_NAME.exec(leaf) ?? LEGACY_ATOMIC_TEMP_NAME.exec(leaf);
  if (!match) return null;
  const target = `${prefix}${match[1]}`;
  const pid = Number(match[2]);
  return isRecoverableAtomicTarget(target) &&
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    pid <= 0x7fff_ffff
    ? { target, pid }
    : null;
}

async function assertIgnorableAbandonedAtomicTemp(
  path: string,
  parent: string,
): Promise<void> {
  const parentInfo = await lstat(parent, { bigint: true });
  const named = await lstat(path, { bigint: true });
  const currentUid = process.getuid?.();
  if (
    parentInfo.isSymbolicLink() ||
    !parentInfo.isDirectory() ||
    named.isSymbolicLink() ||
    !named.isFile() ||
    named.nlink !== 1n ||
    named.dev !== parentInfo.dev ||
    (currentUid !== undefined &&
      (named.uid !== BigInt(currentUid) || (named.mode & 0o077n) !== 0n)) ||
    named.size > BigInt(MAX_METADATA_BYTES)
  ) {
    throw new Error(
      "CreatorCut abandoned atomic-write temp failed identity checks",
    );
  }
}

function assertAtomicTempOwnerStopped(pid: number | null): void {
  if (pid === null) return;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw new Error(
      "CreatorCut atomic-write temp owner may still be live; stop every legacy writer before adoption",
      { cause: error },
    );
  }
  throw new Error(
    "CreatorCut atomic-write temp owner is still running; stop every legacy writer before adoption",
  );
}

async function assertLegacyAdoptionAtomicTempsQuiescent(
  creatorcutDirectory: string,
): Promise<void> {
  for (const [directory, prefix] of [
    [creatorcutDirectory, ""],
    [join(creatorcutDirectory, "versions"), "versions"],
    [join(creatorcutDirectory, "tasks"), "tasks"],
  ] as const) {
    let directoryInfo;
    try {
      directoryInfo = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      continue;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abandonedAtomic = abandonedAtomicTarget(relativePath);
      if (abandonedAtomic === null) continue;
      await assertIgnorableAbandonedAtomicTemp(
        join(directory, entry.name),
        directory,
      );
      assertAtomicTempOwnerStopped(abandonedAtomic.pid);
    }
  }
}

async function writePrivateBufferNoReplace(
  path: string,
  contents: Buffer,
  trustedParent: readonly TrustedDirectoryIdentity[],
): Promise<void> {
  await assertTrustedDirectoryChain(trustedParent);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle: FileHandle | null = null;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    const opened = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    await assertTrustedDirectoryChain(trustedParent);
    if (
      !opened.isFile() ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    ) {
      throw new Error("Restore destination identity changed before write");
    }
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close();
  }
}

async function atomicPrivateText(
  path: string,
  contents: string,
): Promise<void> {
  await atomicPrivateBuffer(path, Buffer.from(contents, "utf8"));
}

async function atomicPrivateJson(path: string, value: unknown): Promise<void> {
  await atomicPrivateText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function safeRelativePath(value: string): void {
  const segments = value.split(/[\\/]/u);
  if (
    !value ||
    value.includes("\0") ||
    isAbsolute(value) ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes(":") ||
    value.includes("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new TypeError(`Unsafe metadata path: ${value}`);
  }
}

function safeAssetRelativePath(
  value: string,
  schemaPolicy: LocalMetadataSchemaPolicy,
): void {
  const legacyGeneratedPrefix = ".creatorcut\\generated\\";
  if (
    schemaPolicy === "frozen-legacy" &&
    value.startsWith(legacyGeneratedPrefix)
  ) {
    const normalized = value.replaceAll("\\", "/");
    safeRelativePath(normalized);
    if (!normalized.startsWith(".creatorcut/generated/")) {
      throw new TypeError(`Unsafe legacy generated asset path: ${value}`);
    }
    return;
  }
  safeRelativePath(value);
}

function isAllowedMetadataPath(
  relativePath: string,
  purpose: "backup" | "state" | "transaction",
): boolean {
  if (/^versions\/(?:0|[1-9]\d*)\.json$/u.test(relativePath)) return true;
  if (/^tasks\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u.test(relativePath)) {
    return purpose !== "backup";
  }
  if (purpose === "backup") {
    return (
      BACKUP_ROOT_JSON.has(relativePath) || BACKUP_ROOT_JSONL.has(relativePath)
    );
  }
  if (purpose === "transaction") {
    return (
      PUBLIC_MANAGED_ROOT.has(relativePath) ||
      relativePath === AUTHORITY_FILE ||
      relativePath === MUTATION_JOURNAL_FILE
    );
  }
  return PUBLIC_MANAGED_ROOT.has(relativePath);
}

function validateMetadataContents(
  contents: Buffer,
  relativePath: string,
): void {
  if (contents.byteLength > MAX_METADATA_BYTES) {
    throw new TypeError(
      `Metadata file is not a small regular file: ${relativePath}`,
    );
  }
  if (contents.includes(0)) {
    throw new TypeError(`Metadata file contains binary data: ${relativePath}`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new TypeError(`Metadata file is not UTF-8 text: ${relativePath}`);
  }
  try {
    if (relativePath.endsWith(".jsonl")) {
      for (const line of text.split("\n").filter(Boolean)) JSON.parse(line);
    } else {
      JSON.parse(text);
    }
  } catch {
    throw new TypeError(`Metadata file is not valid JSON: ${relativePath}`);
  }
}

async function readMetadataBuffer(
  directory: string,
  relativePath: string,
): Promise<Buffer> {
  safeRelativePath(relativePath);
  const root = await realpath(directory);
  const candidate = resolve(root, ...relativePath.split("/"));
  if (!containedChild(root, candidate)) {
    throw new TypeError(`Metadata path escapes its root: ${relativePath}`);
  }
  await rejectSymlinkComponents(dirname(candidate), "Metadata parent path");
  const canonicalParent = await realpath(dirname(candidate));
  if (canonicalParent !== root && !containedChild(root, canonicalParent)) {
    throw new TypeError(`Metadata path escapes its root: ${relativePath}`);
  }
  const trustedDirectories = await openTrustedDirectoryChain(
    root,
    dirname(candidate),
  );
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle: FileHandle | null = null;
  try {
    handle = await open(candidate, constants.O_RDONLY | noFollow);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_METADATA_BYTES)) {
      throw new TypeError(
        `Metadata file is not a small regular file: ${relativePath}`,
      );
    }
    const openedPath = await lstat(candidate, { bigint: true });
    if (
      openedPath.isSymbolicLink() ||
      !openedPath.isFile() ||
      openedPath.dev !== before.dev ||
      openedPath.ino !== before.ino
    ) {
      throw new Error(
        `Metadata path identity changed before read: ${relativePath}`,
      );
    }
    await assertTrustedDirectoryChain(trustedDirectories);
    const contents = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      contents.byteLength !== Number(before.size)
    ) {
      throw new Error(`Metadata changed while reading: ${relativePath}`);
    }
    const current = await lstat(candidate, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.dev !== before.dev ||
      current.ino !== before.ino
    ) {
      throw new Error(`Metadata path identity changed: ${relativePath}`);
    }
    await assertTrustedDirectoryChain(trustedDirectories);
    validateMetadataContents(contents, relativePath);
    return contents;
  } finally {
    await handle?.close();
    await closeTrustedDirectoryChain(trustedDirectories);
  }
}

async function openTrustedDirectoryChain(
  root: string,
  leaf: string,
): Promise<TrustedDirectoryIdentity[]> {
  if (leaf !== root && !containedChild(root, leaf)) {
    throw new TypeError("Trusted metadata directory escapes its root");
  }
  const suffix = relative(root, leaf);
  const paths = [root];
  let current = root;
  for (const segment of suffix ? suffix.split(sep) : []) {
    current = join(current, segment);
    paths.push(current);
  }
  const identities: TrustedDirectoryIdentity[] = [];
  try {
    for (const path of paths) {
      const before = await lstat(path, { bigint: true });
      if (before.isSymbolicLink() || !before.isDirectory()) {
        throw new TypeError("Metadata parent path must be a trusted directory");
      }
      if ((await realpath(path)) !== path) {
        throw new TypeError("Metadata parent path changed identity");
      }
      const handle = await open(
        path,
        constants.O_RDONLY |
          (constants.O_DIRECTORY ?? 0) |
          (constants.O_NOFOLLOW ?? 0),
      );
      const opened = await handle.stat({ bigint: true });
      if (
        !opened.isDirectory() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino
      ) {
        await handle.close();
        throw new Error("Metadata parent path changed while opening");
      }
      identities.push({
        path,
        handle,
        dev: opened.dev,
        ino: opened.ino,
      });
    }
    return identities;
  } catch (error) {
    await closeTrustedDirectoryChain(identities);
    throw error;
  }
}

async function assertTrustedDirectoryChain(
  identities: readonly TrustedDirectoryIdentity[],
): Promise<void> {
  for (const identity of identities) {
    const opened = await identity.handle.stat({ bigint: true });
    const current = await lstat(identity.path, { bigint: true });
    if (
      !opened.isDirectory() ||
      opened.dev !== identity.dev ||
      opened.ino !== identity.ino ||
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      (await realpath(identity.path)) !== identity.path
    ) {
      throw new Error("Metadata parent path identity changed while reading");
    }
  }
}

async function closeTrustedDirectoryChain(
  identities: readonly TrustedDirectoryIdentity[],
): Promise<void> {
  await Promise.allSettled(
    [...identities].reverse().map((identity) => identity.handle.close()),
  );
}

async function readLocalEvidenceBuffer(
  projectDirectory: string,
  relativePath: string,
): Promise<Buffer> {
  safeRelativePath(relativePath);
  const root = await realpath(projectDirectory);
  const candidate = resolve(root, ...relativePath.split("/"));
  if (!containedChild(root, candidate)) {
    throw new TypeError("Local evidence path escapes its project");
  }
  await rejectSymlinkComponents(dirname(candidate), "Local evidence parent");
  const canonicalParent = await realpath(dirname(candidate));
  if (canonicalParent !== root && !containedChild(root, canonicalParent)) {
    throw new TypeError("Local evidence path escapes its project");
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(candidate, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(1024 * 1024 * 1024)) {
      throw new TypeError("Local evidence is not a bounded regular file");
    }
    const contents = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      contents.byteLength !== Number(before.size)
    ) {
      throw new Error("Local evidence changed while reading");
    }
    return contents;
  } finally {
    await handle.close();
  }
}

async function readValidatedLocalArtifact(
  creatorcutDirectory: string,
  relativePath: string,
): Promise<Record<string, unknown> | null> {
  let contents: Buffer;
  try {
    contents = await readMetadataBuffer(creatorcutDirectory, relativePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return validateLocalArtifact(
    relativePath,
    JSON.parse(contents.toString("utf8")),
  ) as Record<string, unknown>;
}

async function assertRetainedRuntimeDirectory(
  creatorcutDirectory: string,
  path: string,
  relativePath: string,
): Promise<void> {
  safeRelativePath(relativePath);
  const root = await realpath(creatorcutDirectory);
  const candidate = await realpath(path);
  const expected = resolve(root, ...relativePath.split("/"));
  if (candidate !== expected || !containedChild(root, candidate)) {
    throw new TypeError(
      `Retained runtime directory escapes project metadata: ${relativePath}`,
    );
  }
  const identities = await openTrustedDirectoryChain(root, candidate);
  try {
    const rootIdentity = identities[0];
    const leafIdentity = identities.at(-1);
    if (
      !rootIdentity ||
      !leafIdentity ||
      leafIdentity.dev !== rootIdentity.dev
    ) {
      throw new TypeError(
        `Retained runtime directory must stay on the project filesystem: ${relativePath}`,
      );
    }
    const leaf = await leafIdentity.handle.stat({ bigint: true });
    const currentUid = process.getuid?.();
    if (
      !leaf.isDirectory() ||
      (currentUid !== undefined &&
        (leaf.uid !== BigInt(currentUid) || (leaf.mode & 0o077n) !== 0n))
    ) {
      throw new TypeError(
        `Retained runtime directory is not a private local directory: ${relativePath}`,
      );
    }
    await assertTrustedDirectoryChain(identities);
  } finally {
    await closeTrustedDirectoryChain(identities);
  }
}

async function assertCompletedLegacyTranscriptionWork(
  creatorcutDirectory: string,
): Promise<void> {
  const task = await readValidatedLocalArtifact(
    creatorcutDirectory,
    "tasks/transcription.json",
  );
  if (!task || task.state !== "completed") {
    throw new Error(
      "Legacy transcription work cannot be adopted while its task is not completed",
    );
  }
}

async function assertLegacyAdoptionTasksCompleted(
  creatorcutDirectory: string,
): Promise<void> {
  const tasksDirectory = join(creatorcutDirectory, "tasks");
  if (!(await pathExists(tasksDirectory))) return;
  let hasTranscriptionWork = false;
  for (const entry of await readdir(tasksDirectory, { withFileTypes: true })) {
    const relativePath = `tasks/${entry.name}`;
    const abandonedAtomic = abandonedAtomicTarget(relativePath);
    if (abandonedAtomic !== null) {
      await assertIgnorableAbandonedAtomicTemp(
        join(tasksDirectory, entry.name),
        tasksDirectory,
      );
      continue;
    }
    if (relativePath === "tasks/transcription-work") {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TypeError(
          "Retained runtime directory is not a local non-symlink directory: tasks/transcription-work",
        );
      }
      await assertRetainedRuntimeDirectory(
        creatorcutDirectory,
        join(tasksDirectory, entry.name),
        relativePath,
      );
      hasTranscriptionWork = true;
      continue;
    }
    if (
      entry.isSymbolicLink() ||
      !entry.isFile() ||
      !LEGACY_ADOPTION_TASK_PATHS.has(relativePath)
    ) {
      throw new Error(`Legacy task cannot be adopted: ${relativePath}`);
    }
  }

  const importTask = await readValidatedLocalArtifact(
    creatorcutDirectory,
    "tasks/import.json",
  );
  if (importTask && importTask.state !== "completed") {
    throw new Error("Legacy import task is not completed");
  }
  const project = JSON.parse(
    (await readMetadataBuffer(creatorcutDirectory, "project.json")).toString(
      "utf8",
    ),
  ) as Record<string, unknown>;
  const baseSnapshots = new Map<number, Record<string, unknown>>();
  const baseSnapshot = async (
    revision: number,
  ): Promise<Record<string, unknown>> => {
    const cached = baseSnapshots.get(revision);
    if (cached) return cached;
    let contents: Buffer;
    try {
      contents = await readMetadataBuffer(
        creatorcutDirectory,
        `versions/${revision}.json`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `Completed legacy task base revision is missing: ${revision}`,
        );
      }
      throw error;
    }
    const snapshot = JSON.parse(contents.toString("utf8")) as unknown;
    if (
      !isRecord(snapshot) ||
      snapshot.revision !== revision ||
      !isRecord(snapshot.project) ||
      !isRecord(snapshot.transcript)
    ) {
      throw new Error(
        `Completed legacy task base revision is invalid: ${revision}`,
      );
    }
    baseSnapshots.set(revision, snapshot);
    return snapshot;
  };

  for (const [kind, taskPath, locatorPath] of [
    ["export", "tasks/export.json", "tasks/export-locator.json"],
    [
      "transcription",
      "tasks/transcription.json",
      "tasks/transcription-locator.json",
    ],
  ] as const) {
    const [taskExists, locatorExists] = await Promise.all([
      pathExists(join(creatorcutDirectory, taskPath)),
      pathExists(join(creatorcutDirectory, locatorPath)),
    ]);
    if (taskExists !== locatorExists) {
      throw new Error(
        `Legacy ${kind} task and locator must be a complete pair`,
      );
    }
    if (!taskExists) continue;
    const [task, locator] = await Promise.all([
      readValidatedLocalArtifact(creatorcutDirectory, taskPath),
      readValidatedLocalArtifact(creatorcutDirectory, locatorPath),
    ]);
    if (!task || !locator) throw new Error(`Legacy ${kind} task pair changed`);
    if (task && task.state !== "completed") {
      throw new Error(`Legacy ${kind} task is not completed`);
    }
    if (task.project_id !== project.project_id) {
      throw new Error(
        `Completed legacy ${kind} task is not bound to the project`,
      );
    }
    const taskBaseRevision = task.base_revision as number;
    const taskBase = await baseSnapshot(taskBaseRevision);
    if (!isRecord(task.result)) {
      throw new Error(`Completed legacy ${kind} task result is missing`);
    }
    if (task.progress_millis !== 1000 || task.error !== undefined) {
      throw new Error(
        `Completed legacy ${kind} task has an invalid finished state`,
      );
    }
    if (kind === "export") {
      if (
        task.output_path !== task.result.output_path ||
        task.output_sha256 !== task.result.output_sha256 ||
        locator.output_path !== task.result.output_path ||
        task.result.quality !== "export"
      ) {
        throw new Error(
          "Completed legacy export output binding is inconsistent",
        );
      }
    } else {
      const taskBaseProject = taskBase.project as Record<string, unknown>;
      const assets = Array.isArray(taskBaseProject.assets)
        ? taskBaseProject.assets
        : [];
      const source = assets.find(
        (entry) => isRecord(entry) && entry.asset_id === task.source_asset_id,
      ) as Record<string, unknown> | undefined;
      if (!source || source.sha256 !== task.source_sha256) {
        throw new Error(
          "Completed legacy transcription task is not bound to its source asset",
        );
      }
      if (
        !Array.isArray(task.completed_steps) ||
        !task.completed_steps.includes("transcript_persisted")
      ) {
        throw new Error(
          "Completed legacy transcription task is missing its persisted step",
        );
      }
    }
  }
  if (hasTranscriptionWork) {
    await assertCompletedLegacyTranscriptionWork(creatorcutDirectory);
  }
}

async function collectMetadataFiles(
  directory: string,
  purpose: "backup" | "state" | "transaction",
  prefix = "",
  creatorcutDirectory = directory,
): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abandonedAtomic = abandonedAtomicTarget(relativePath);
    if (abandonedAtomic !== null) {
      await assertIgnorableAbandonedAtomicTemp(
        join(directory, entry.name),
        directory,
      );
      continue;
    }
    if (
      !prefix &&
      purpose === "state" &&
      [
        AUTHORITY_FILE,
        MUTATION_JOURNAL_FILE,
        LEGACY_HEAD_FILE,
        "m1-1-dogfood-report.json",
        "import-source.json",
        "studio.json",
      ].includes(relativePath)
    ) {
      continue;
    }
    if (
      !prefix &&
      [
        LOCK_FILE,
        LOCK_RECOVERY_DIRECTORY,
        PENDING_FILE,
        PUBLIC_MUTATION_PENDING_FILE,
        STAGING_DIRECTORY,
        MUTATION_STAGING_DIRECTORY,
      ].includes(relativePath)
    ) {
      continue;
    }
    if (relativePath === INTERNAL_TRANSACTION_FILE) {
      throw new Error(
        "CreatorCut internal transaction recovery must complete before migration",
      );
    }
    if (RETAINED_RUNTIME_DIRECTORIES.has(relativePath)) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TypeError(
          `Retained runtime directory is not a local non-symlink directory: ${relativePath}`,
        );
      }
      await assertRetainedRuntimeDirectory(
        creatorcutDirectory,
        join(directory, entry.name),
        relativePath,
      );
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new TypeError(`Metadata contains symbolic link: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      if (
        (!prefix &&
          [STAGING_DIRECTORY, MUTATION_STAGING_DIRECTORY].includes(
            entry.name,
          )) ||
        (!prefix && ["versions", "tasks"].includes(entry.name))
      ) {
        if (
          [STAGING_DIRECTORY, MUTATION_STAGING_DIRECTORY].includes(entry.name)
        ) {
          continue;
        }
        result.push(
          ...(await collectMetadataFiles(
            join(directory, entry.name),
            purpose,
            relativePath,
            creatorcutDirectory,
          )),
        );
        continue;
      }
      throw new TypeError(`Unknown metadata directory: ${relativePath}`);
    } else if (entry.isFile()) {
      if (!isAllowedMetadataPath(relativePath, purpose)) {
        throw new TypeError(
          `Unknown or non-metadata project file: ${relativePath}`,
        );
      }
      result.push(relativePath);
    } else {
      throw new TypeError(`Unsupported metadata entry: ${relativePath}`);
    }
  }
  return result.sort();
}

async function collectManagedPathsForRestore(
  directory: string,
  prefix = "",
  creatorcutDirectory = directory,
): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abandonedAtomic = abandonedAtomicTarget(relativePath);
    if (abandonedAtomic !== null) {
      await assertIgnorableAbandonedAtomicTemp(
        join(directory, entry.name),
        directory,
      );
      continue;
    }
    if (
      !prefix &&
      [
        LOCK_FILE,
        LOCK_RECOVERY_DIRECTORY,
        PENDING_FILE,
        PUBLIC_MUTATION_PENDING_FILE,
        STAGING_DIRECTORY,
        MUTATION_STAGING_DIRECTORY,
      ].includes(relativePath)
    ) {
      continue;
    }
    if (relativePath === INTERNAL_TRANSACTION_FILE) {
      throw new Error(
        "CreatorCut internal transaction recovery must complete before public mutation recovery",
      );
    }
    if (RETAINED_RUNTIME_DIRECTORIES.has(relativePath)) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TypeError(
          `Retained runtime directory is not a local non-symlink directory: ${relativePath}`,
        );
      }
      await assertRetainedRuntimeDirectory(
        creatorcutDirectory,
        join(directory, entry.name),
        relativePath,
      );
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new TypeError(`Metadata contains symbolic link: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      if (!prefix && ["versions", "tasks"].includes(entry.name)) {
        result.push(
          ...(await collectManagedPathsForRestore(
            join(directory, entry.name),
            relativePath,
            creatorcutDirectory,
          )),
        );
        continue;
      }
      throw new TypeError(`Unknown metadata directory: ${relativePath}`);
    }
    if (!entry.isFile()) {
      throw new TypeError(`Unsupported metadata entry: ${relativePath}`);
    }
    if (!isAllowedMetadataPath(relativePath, "transaction")) {
      throw new TypeError(
        `Unknown or non-metadata project file: ${relativePath}`,
      );
    }
    result.push(relativePath);
  }
  return result.sort();
}

async function metadataEntries(
  directory: string,
  purpose: "backup" | "state" | "transaction",
): Promise<MetadataBackupFile[]> {
  return (await readMetadataSnapshot(directory, purpose)).files;
}

async function readMetadataSnapshot(
  directory: string,
  purpose: "backup" | "state" | "transaction",
): Promise<{
  files: MetadataBackupFile[];
  contents: ReadonlyMap<string, Buffer>;
}> {
  const entries: MetadataBackupFile[] = [];
  const contentsByPath = new Map<string, Buffer>();
  for (const relativePath of await collectMetadataFiles(directory, purpose)) {
    const contents = await readMetadataBuffer(directory, relativePath);
    contentsByPath.set(relativePath, contents);
    entries.push({
      relative_path: relativePath,
      sha256: digest(contents).slice(7),
      size_bytes: contents.byteLength,
    });
  }
  return { files: entries, contents: contentsByPath };
}

function equalEntries(
  left: MetadataBackupFile[],
  right: MetadataBackupFile[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.relative_path === right[index]?.relative_path &&
        entry.sha256 === right[index]?.sha256 &&
        entry.size_bytes === right[index]?.size_bytes,
    )
  );
}

function entriesDigest(entries: MetadataBackupFile[]): string {
  return digest(
    entries
      .map(
        (entry) =>
          `${entry.relative_path}\0${entry.size_bytes}\0${entry.sha256}\n`,
      )
      .join(""),
  );
}

export async function managedMetadataDigest(
  creatorcutDirectory: string,
): Promise<string> {
  const snapshot = await readMetadataSnapshot(creatorcutDirectory, "state");
  const entries: string[] = [];
  for (const file of snapshot.files) {
    const contents = snapshot.contents.get(file.relative_path)!;
    entries.push(
      `${file.relative_path}\0${contents.byteLength}\0${digest(contents)}\n`,
    );
  }
  return digest(entries.join(""));
}

async function rejectSymlinkComponents(
  path: string,
  label: string,
): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new TypeError(`${label} cannot traverse a symbolic link`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function canonicalFuturePath(path: string): Promise<string> {
  const absolute = resolve(path);
  let cursor = absolute;
  const missing: string[] = [];
  while (!(await pathExists(cursor))) {
    missing.unshift(parse(cursor).base);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const canonicalAncestor = await realpath(cursor);
  return resolve(canonicalAncestor, ...missing);
}

async function safeStageDirectory(
  creatorcutDirectory: string,
  migrationId: string,
): Promise<SafeCleanupDirectory> {
  assertIdentifier(migrationId, "Migration ID");
  const creatorcutRoot = await realpath(creatorcutDirectory);
  const stagingRoot = resolve(creatorcutRoot, STAGING_DIRECTORY);
  const candidate = resolve(stagingRoot, migrationId);
  if (
    creatorcutRoot === resolve("/") ||
    candidate === creatorcutRoot ||
    candidate === stagingRoot ||
    !containedChild(creatorcutRoot, stagingRoot) ||
    !containedChild(stagingRoot, candidate)
  ) {
    throw new TypeError("Authority migration stage path is unsafe");
  }
  await rejectSymlinkComponents(
    stagingRoot,
    "Authority migration staging root",
  );
  await rejectSymlinkComponents(
    candidate,
    "Authority migration stage directory",
  );
  return candidate as SafeCleanupDirectory;
}

async function safeAuthorityStagingRoot(
  creatorcutDirectory: string,
): Promise<SafeCleanupDirectory> {
  const creatorcutRoot = await realpath(creatorcutDirectory);
  const stagingRoot = resolve(creatorcutRoot, STAGING_DIRECTORY);
  if (
    creatorcutRoot === resolve("/") ||
    stagingRoot === creatorcutRoot ||
    !containedChild(creatorcutRoot, stagingRoot)
  ) {
    throw new TypeError("Authority migration staging root is unsafe");
  }
  if (await pathExists(stagingRoot)) {
    const info = await lstat(stagingRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new TypeError(
        "Authority migration staging root must be a trusted directory",
      );
    }
    if ((await realpath(stagingRoot)) !== stagingRoot) {
      throw new TypeError("Authority migration staging root escapes project");
    }
  }
  return stagingRoot as SafeCleanupDirectory;
}

async function assertAuthorityStagingInventory(
  creatorcutDirectory: string,
  allowedMigrationId: string | null,
): Promise<void> {
  if (allowedMigrationId !== null) {
    assertIdentifier(allowedMigrationId, "Migration ID");
  }
  const stagingRoot = await safeAuthorityStagingRoot(creatorcutDirectory);
  if (!(await pathExists(stagingRoot))) return;
  const entries = await readdir(stagingRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (
      allowedMigrationId === null ||
      entry.name !== allowedMigrationId ||
      !entry.isDirectory() ||
      entry.isSymbolicLink()
    ) {
      throw new Error(
        `Authority migration staging root contains unbound entry: ${entry.name}`,
      );
    }
    const child = join(stagingRoot, entry.name);
    const childRealPath = await realpath(child);
    if (!containedChild(stagingRoot, childRealPath)) {
      throw new Error("Authority migration stage escapes its staging root");
    }
  }
}

async function removeAuthorityStageAndEmptyRoot(
  creatorcutDirectory: string,
  migrationId: string,
): Promise<void> {
  await assertAuthorityStagingInventory(creatorcutDirectory, migrationId);
  const stage = await safeStageDirectory(creatorcutDirectory, migrationId);
  await removeSafeDirectory(stage);
  const stagingRoot = await safeAuthorityStagingRoot(creatorcutDirectory);
  if (!(await pathExists(stagingRoot))) return;
  const remaining = await readdir(stagingRoot);
  if (remaining.length !== 0) {
    throw new Error("Authority migration staging root is not empty");
  }
  await removeSafeDirectory(stagingRoot);
}

function pendingForCommittedMarker(
  marker: StorageAuthorityMarker,
): PendingAuthorityMigration {
  if (
    marker.source_format !== "creatorcut-internal-project-store/1.0-alpha" ||
    marker.handoff_source_files_digest === null ||
    marker.handoff_stage_files_digest === null
  ) {
    throw new Error("Authority marker does not bind an internal handoff stage");
  }
  return {
    schema_version: "creatorcut-authority-migration/1.1",
    direction: "to_public",
    phase: "installing",
    migration_id: marker.migration_id,
    project_id: marker.project_id,
    revision: marker.adopted_revision,
    backup_manifest_digest: marker.backup_manifest_digest,
    source_manifest_digest: marker.handoff_source_files_digest,
    stage_files_digest: marker.handoff_stage_files_digest,
    created_at: marker.activated_at,
  };
}

async function removeVerifiedCommittedAuthorityStage(
  creatorcutDirectory: string,
  marker: StorageAuthorityMarker,
): Promise<void> {
  await assertAuthorityStagingInventory(
    creatorcutDirectory,
    marker.migration_id,
  );
  const stageDirectory = await safeStageDirectory(
    creatorcutDirectory,
    marker.migration_id,
  );
  if (!(await pathExists(stageDirectory))) {
    await removeAuthorityStageAndEmptyRoot(
      creatorcutDirectory,
      marker.migration_id,
    );
    return;
  }
  const pending = pendingForCommittedMarker(marker);
  const verified = await verifyStage(pending, stageDirectory);
  if (verified.files_digest !== marker.handoff_stage_files_digest) {
    throw new Error(
      "Committed authority stage digest does not match its marker",
    );
  }
  const installed = await readMetadataSnapshot(creatorcutDirectory, "state");
  if (
    !equalEntries(installed.files, verified.files) ||
    entriesDigest(installed.files) !== marker.handoff_stage_files_digest
  ) {
    throw new Error("Committed authority stage does not match installed state");
  }
  await removeAuthorityStageAndEmptyRoot(
    creatorcutDirectory,
    marker.migration_id,
  );
}

async function safeMutationStageDirectory(
  creatorcutDirectory: string,
  transactionId: string,
): Promise<SafeCleanupDirectory> {
  assertIdentifier(transactionId, "Public mutation transaction ID");
  const stagingRoot = await safeMutationStagingRoot(creatorcutDirectory);
  const creatorcutRoot = await realpath(creatorcutDirectory);
  const candidate = resolve(stagingRoot, transactionId);
  if (
    !containedChild(creatorcutRoot, stagingRoot) ||
    !containedChild(stagingRoot, candidate)
  ) {
    throw new TypeError("Public mutation stage path is unsafe");
  }
  await rejectSymlinkComponents(stagingRoot, "Public mutation staging root");
  await rejectSymlinkComponents(candidate, "Public mutation stage directory");
  return candidate as SafeCleanupDirectory;
}

async function safeMutationStagingRoot(
  creatorcutDirectory: string,
): Promise<SafeCleanupDirectory> {
  const creatorcutRoot = await realpath(creatorcutDirectory);
  const stagingRoot = resolve(creatorcutRoot, MUTATION_STAGING_DIRECTORY);
  if (
    creatorcutRoot === resolve("/") ||
    stagingRoot === creatorcutRoot ||
    !containedChild(creatorcutRoot, stagingRoot)
  ) {
    throw new TypeError("Public mutation staging root is unsafe");
  }
  await rejectSymlinkComponents(stagingRoot, "Public mutation staging root");
  return stagingRoot as SafeCleanupDirectory;
}

function safeProjectDirectory(
  creatorcutDirectory: string,
  childName: "versions",
): SafeCleanupDirectory {
  const root = resolve(creatorcutDirectory);
  const candidate = resolve(root, childName);
  if (!containedChild(root, candidate)) {
    throw new TypeError("CreatorCut project cleanup path is unsafe");
  }
  return candidate as SafeCleanupDirectory;
}

async function removeSafeDirectory(path: SafeCleanupDirectory): Promise<void> {
  await rm(path, { recursive: true, force: true });
  if (await pathExists(dirname(path))) await syncDirectory(dirname(path));
}

async function validateBackupRoot(
  creatorcutDirectory: string,
  backupDirectory: string,
): Promise<string> {
  const lexicalBackupRoot = resolve(backupDirectory);
  if (
    (await pathExists(lexicalBackupRoot)) &&
    (await lstat(lexicalBackupRoot)).isSymbolicLink()
  ) {
    throw new TypeError("Migration backup path cannot be a symbolic link");
  }
  const backupRoot = await canonicalFuturePath(lexicalBackupRoot);
  const creatorcutRoot = await realpath(creatorcutDirectory);
  const projectRoot = await realpath(dirname(creatorcutRoot));
  const forbidden = new Set([
    resolve("/"),
    resolve(homedir()),
    projectRoot,
    creatorcutRoot,
    resolve(creatorcutRoot, STAGING_DIRECTORY),
  ]);
  if (
    forbidden.has(backupRoot) ||
    containedChild(projectRoot, backupRoot) ||
    containedChild(backupRoot, projectRoot)
  ) {
    throw new TypeError("Migration backup path is unsafe");
  }
  return backupRoot;
}

function assertMarker(value: unknown): StorageAuthorityMarker {
  if (!isRecord(value)) {
    throw new TypeError("CreatorCut storage authority marker is invalid");
  }
  assertExactKeys(value, MARKER_KEYS, "CreatorCut storage authority marker");
  if (
    value.schema_version !== "creatorcut-storage-authority/1.0" ||
    value.authority !== "public-runtime" ||
    !Number.isSafeInteger(value.generation) ||
    !Number.isSafeInteger(value.handoff_generation) ||
    Number(value.generation) < Number(value.handoff_generation) ||
    !Number.isSafeInteger(value.adopted_revision) ||
    !Number.isSafeInteger(value.current_revision) ||
    Number(value.current_revision) < Number(value.adopted_revision) ||
    ![
      "creatorcut-internal-project-store/1.0-alpha",
      "creatorcut-public-runtime/1.0",
    ].includes(String(value.source_format))
  ) {
    throw new TypeError("CreatorCut storage authority marker is invalid");
  }
  assertIdentifier(value.migration_id, "Authority migration ID");
  assertIdentifier(value.project_id, "Authority project ID");
  assertDigest(value.backup_manifest_digest, "Authority backup digest");
  if (value.source_format === "creatorcut-internal-project-store/1.0-alpha") {
    assertDigest(
      value.handoff_source_files_digest,
      "Authority handoff source digest",
    );
    assertDigest(
      value.handoff_stage_files_digest,
      "Authority handoff stage digest",
    );
  } else if (
    value.handoff_source_files_digest !== null ||
    value.handoff_stage_files_digest !== null
  ) {
    throw new TypeError(
      "Native public authority cannot claim an internal handoff digest",
    );
  }
  assertDigest(value.canonical_state_digest, "Authority state digest");
  assertIsoDate(value.activated_at, "Authority activation time");
  assertIsoDate(value.updated_at, "Authority update time");
  return value as unknown as StorageAuthorityMarker;
}

function assertPending(value: unknown): PendingAuthorityMigration {
  if (!isRecord(value))
    throw new TypeError("Pending authority migration is invalid");
  assertExactKeys(value, PENDING_KEYS, "Pending authority migration");
  if (
    value.schema_version !== "creatorcut-authority-migration/1.1" ||
    !["to_public", "rollback_to_internal"].includes(String(value.direction)) ||
    !["source_locked", "staged", "installing", "rollback_locked"].includes(
      String(value.phase),
    ) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0
  ) {
    throw new TypeError("Pending authority migration is invalid");
  }
  assertIdentifier(value.migration_id, "Pending migration ID");
  assertIdentifier(value.project_id, "Pending project ID");
  assertDigest(value.backup_manifest_digest, "Pending backup digest");
  assertDigest(value.source_manifest_digest, "Pending source digest");
  if (value.stage_files_digest !== null) {
    assertDigest(value.stage_files_digest, "Pending stage digest");
  }
  if (
    (value.direction === "to_public" && value.phase === "rollback_locked") ||
    (value.direction === "rollback_to_internal" &&
      value.phase !== "rollback_locked") ||
    (value.phase === "source_locked" && value.stage_files_digest !== null) ||
    (["staged", "installing"].includes(String(value.phase)) &&
      value.stage_files_digest === null)
  ) {
    throw new TypeError("Pending authority migration phase is invalid");
  }
  assertIsoDate(value.created_at, "Pending creation time");
  return value as unknown as PendingAuthorityMigration;
}

function assertPublicMutationPending(value: unknown): PendingPublicMutation {
  if (!isRecord(value))
    throw new TypeError("Pending public mutation is invalid");
  assertExactKeys(
    value,
    PUBLIC_MUTATION_PENDING_KEYS,
    "Pending public mutation",
  );
  if (
    value.schema_version !== "creatorcut-public-mutation/1.1" ||
    !Number.isSafeInteger(value.base_revision) ||
    !Number.isSafeInteger(value.base_generation) ||
    !Number.isSafeInteger(value.expected_generation) ||
    Number(value.expected_generation) !== Number(value.base_generation) + 1
  ) {
    throw new TypeError("Pending public mutation is invalid");
  }
  assertIdentifier(value.transaction_id, "Public mutation transaction ID");
  assertIdentifier(value.project_id, "Public mutation project ID");
  assertIdentifier(value.mutation_kind, "Public mutation kind");
  assertDigest(
    value.base_canonical_state_digest,
    "Public mutation base canonical digest",
  );
  assertDigest(
    value.before_snapshot_digest,
    "Public mutation before snapshot digest",
  );
  assertIsoDate(value.created_at, "Public mutation creation time");
  return value as unknown as PendingPublicMutation;
}

function parseJsonLines<T>(contents: string, label: string): T[] {
  try {
    return contents
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    throw new TypeError(`${label} is not valid JSONL`);
  }
}

function assertStorageMutationJournalEntry(
  value: unknown,
): StorageMutationJournalEntry {
  if (!isRecord(value)) {
    throw new TypeError("CreatorCut mutation journal entry is invalid");
  }
  assertExactKeys(
    value,
    STORAGE_MUTATION_JOURNAL_KEYS,
    "CreatorCut mutation journal entry",
  );
  if (
    value.schema_version !== "creatorcut-storage-mutation/1.0" ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 0 ||
    !Number.isSafeInteger(value.project_revision) ||
    Number(value.project_revision) < 0
  ) {
    throw new TypeError("CreatorCut mutation journal entry is invalid");
  }
  assertIdentifier(value.migration_id, "Mutation journal migration ID");
  assertIdentifier(value.project_id, "Mutation journal project ID");
  assertIdentifier(value.mutation_kind, "Mutation journal mutation kind");
  assertDigest(
    value.canonical_state_digest,
    "Mutation journal canonical state digest",
  );
  assertIsoDate(value.committed_at, "Mutation journal commit time");
  return value as unknown as StorageMutationJournalEntry;
}

async function validateStorageMutationJournalUnlocked(
  creatorcutDirectory: string,
  marker: StorageAuthorityMarker,
): Promise<StorageMutationJournalEntry[]> {
  const entries = parseJsonLines<unknown>(
    await readFile(join(creatorcutDirectory, MUTATION_JOURNAL_FILE), "utf8"),
    "CreatorCut mutation journal",
  ).map(assertStorageMutationJournalEntry);
  if (entries.length === 0) {
    throw new TypeError("CreatorCut mutation journal is empty");
  }
  for (const [index, entry] of entries.entries()) {
    if (
      entry.generation !== marker.handoff_generation + index ||
      entry.migration_id !== marker.migration_id ||
      entry.project_id !== marker.project_id
    ) {
      throw new TypeError(
        "CreatorCut mutation journal authority binding is invalid",
      );
    }
  }
  const first = entries[0]!;
  const expectedInitialKinds =
    marker.source_format === "creatorcut-internal-project-store/1.0-alpha"
      ? new Set(["authority_handoff"])
      : new Set(["project_create", "public_adopt"]);
  if (
    !expectedInitialKinds.has(first.mutation_kind) ||
    first.generation !== marker.handoff_generation ||
    first.project_revision !== marker.adopted_revision ||
    first.committed_at !== marker.activated_at
  ) {
    throw new TypeError(
      "CreatorCut mutation journal handoff record is invalid",
    );
  }
  const last = entries.at(-1)!;
  if (
    last.generation !== marker.generation ||
    last.project_revision !== marker.current_revision ||
    last.canonical_state_digest !== marker.canonical_state_digest ||
    last.committed_at !== marker.updated_at
  ) {
    throw new TypeError(
      "CreatorCut mutation journal marker binding is invalid",
    );
  }
  return entries;
}

function requireCanonicalJcsEqual(
  actual: unknown,
  reconstructed: unknown,
  label: string,
): void {
  if (digestJcs(actual) !== digestJcs(reconstructed)) {
    throw new TypeError(`${label} is not canonical public metadata`);
  }
}

function validateMigratedCanonicalTranscript(
  value: unknown,
  project: LocalMediaProject,
  revision: number,
  timelineDurationUs: number,
): LocalTranscript {
  const source = requiredRecord(value, "migrated canonical transcript");
  const migrationStatus = requiredString(
    source.migration_status,
    "migrated canonical transcript status",
  );
  if (migrationStatus === "preserved") {
    const sourceRevision = requiredInteger(
      source.source_revision,
      "migrated canonical transcript source revision",
    );
    const legacy: Record<string, unknown> = {
      ...source,
      revision: sourceRevision,
    };
    delete legacy.migration_status;
    delete legacy.source_revision;
    const reconstructed = migrationTranscript(
      legacy,
      project,
      revision,
      timelineDurationUs,
      "canonical",
    );
    requireCanonicalJcsEqual(
      source,
      reconstructed,
      "Migrated canonical transcript",
    );
    return reconstructed;
  }
  if (!["missing_current", "missing_historical"].includes(migrationStatus)) {
    throw new TypeError("Migrated canonical transcript status is invalid");
  }
  assertExactKeys(
    source,
    [
      "schema_version",
      "transcript_id",
      "project_id",
      "revision",
      "language_mode",
      "migration_status",
      "segments",
      "silence_intervals",
    ],
    "Migrated canonical transcript placeholder",
  );
  if (
    source.schema_version !== "1.0" ||
    requiredString(source.project_id, "placeholder transcript project") !==
      project.project_id ||
    requiredInteger(source.revision, "placeholder transcript revision") !==
      revision ||
    source.language_mode !== "auto" ||
    !Array.isArray(source.segments) ||
    source.segments.length !== 0 ||
    !Array.isArray(source.silence_intervals) ||
    source.silence_intervals.length !== 0
  ) {
    throw new TypeError("Migrated canonical transcript placeholder is invalid");
  }
  const reconstructed: LocalTranscript = {
    schema_version: "1.0",
    transcript_id: requiredString(
      source.transcript_id,
      "placeholder transcript id",
    ),
    project_id: project.project_id,
    revision,
    language_mode: "auto",
    migration_status: migrationStatus as
      "missing_current" | "missing_historical",
    segments: [],
    silence_intervals: [],
  };
  requireCanonicalJcsEqual(
    source,
    reconstructed,
    "Migrated canonical transcript placeholder",
  );
  return reconstructed;
}

function validateMigratedCanonicalEditBrief(
  value: unknown,
  project: LocalMediaProject,
  revision: number,
): LocalEditBrief {
  const source = requiredRecord(value, "migrated canonical edit brief");
  const migrationStatus = requiredString(
    source.migration_status,
    "migrated canonical edit brief status",
  );
  if (migrationStatus === "preserved") {
    const sourceBaseRevision = requiredInteger(
      source.source_base_revision,
      "migrated canonical edit brief source revision",
    );
    const legacy: Record<string, unknown> = {
      ...source,
      base_revision: sourceBaseRevision,
    };
    delete legacy.migration_status;
    delete legacy.source_base_revision;
    const reconstructed = migrationEditBrief(
      legacy,
      project,
      revision,
      "canonical",
    );
    requireCanonicalJcsEqual(
      source,
      reconstructed,
      "Migrated canonical edit brief",
    );
    return reconstructed;
  }
  if (!["missing_current", "missing_historical"].includes(migrationStatus)) {
    throw new TypeError("Migrated canonical edit brief status is invalid");
  }
  assertExactKeys(
    source,
    [
      "schema_version",
      "brief_id",
      "project_id",
      "base_revision",
      "audio_mode",
      "caption_style_id",
      "approved",
      "migration_status",
    ],
    "Migrated canonical edit brief placeholder",
  );
  if (
    source.schema_version !== "1.0" ||
    requiredString(source.project_id, "placeholder edit brief project") !==
      project.project_id ||
    requiredInteger(source.base_revision, "placeholder edit brief revision") !==
      revision ||
    source.audio_mode !== "original" ||
    source.caption_style_id !== "caption_none" ||
    source.approved !== false
  ) {
    throw new TypeError("Migrated canonical edit brief placeholder is invalid");
  }
  const reconstructed: LocalEditBrief = {
    schema_version: "1.0",
    brief_id: requiredString(source.brief_id, "placeholder edit brief id"),
    project_id: project.project_id,
    base_revision: revision,
    audio_mode: "original",
    caption_style_id: "caption_none",
    approved: false,
    migration_status: migrationStatus,
  };
  requireCanonicalJcsEqual(
    source,
    reconstructed,
    "Migrated canonical edit brief placeholder",
  );
  return reconstructed;
}

function validateStandardCanonicalTranscript(
  value: unknown,
  project: LocalMediaProject,
  revision: number,
  timelineDurationUs: number,
  requireCanonicalEncoding = true,
): LocalTranscript {
  const source = requiredRecord(value, "canonical transcript");
  if (source.migration_status !== undefined) {
    return validateMigratedCanonicalTranscript(
      source,
      project,
      revision,
      timelineDurationUs,
    );
  }
  const reconstructed = migrationTranscript(
    source,
    project,
    revision,
    timelineDurationUs,
    requireCanonicalEncoding ? "canonical" : "frozen-legacy",
    true,
  );
  const standard: LocalTranscript = { ...reconstructed };
  delete standard.migration_status;
  delete standard.source_revision;
  if (requireCanonicalEncoding) {
    requireCanonicalJcsEqual(source, standard, "Canonical transcript");
    return standard;
  }
  return structuredClone(source) as unknown as LocalTranscript;
}

function validateStandardCanonicalEditBrief(
  value: unknown,
  project: LocalMediaProject,
  revision: number,
  requireCanonicalEncoding = true,
): LocalEditBrief {
  const source = requiredRecord(value, "canonical edit brief");
  if (source.migration_status !== undefined) {
    return validateMigratedCanonicalEditBrief(source, project, revision);
  }
  if (
    (source.schema_version !== "1.0" &&
      (requireCanonicalEncoding || source.schema_version !== "1.0-alpha")) ||
    requiredString(source.brief_id, "canonical edit brief id").length === 0 ||
    requiredString(source.project_id, "canonical edit brief project") !==
      project.project_id ||
    requiredInteger(source.base_revision, "canonical edit brief revision") !==
      revision ||
    !["original", "partial_voiceover", "full_voiceover"].includes(
      String(source.audio_mode),
    ) ||
    requiredString(
      source.caption_style_id,
      "canonical edit brief caption style",
    ).length === 0 ||
    typeof source.approved !== "boolean" ||
    source.source_base_revision !== undefined
  ) {
    throw new TypeError("Canonical edit brief is invalid");
  }
  return structuredClone(source) as LocalEditBrief;
}

function validateMigratedCanonicalSnapshot(
  value: unknown,
  revision: number,
  requireMigrationProvenance: boolean,
  requireCanonicalEncoding = true,
): LocalProjectSnapshot {
  const snapshot = requiredRecord(value, `migrated revision ${revision}`);
  assertAllowedKeys(
    snapshot,
    [
      "schema_version",
      "revision",
      "project",
      "timeline",
      "transcript",
      "edit_brief",
    ],
    [
      "schema_version",
      "revision",
      "project",
      "timeline",
      "transcript",
      "edit_brief",
      "visual_composition",
      "restored_from_revision",
    ],
    `Migrated revision ${revision}`,
  );
  if (
    snapshot.schema_version !== "creatorcut-local-snapshot/1.0" ||
    requiredInteger(snapshot.revision, "migrated snapshot revision") !==
      revision
  ) {
    throw new TypeError(`Migrated revision ${revision} binding is invalid`);
  }
  const schemaPolicy: LocalMetadataSchemaPolicy = requireCanonicalEncoding
    ? "canonical"
    : "frozen-legacy";
  const project = sanitizedProject(snapshot.project, revision, schemaPolicy);
  if (requireCanonicalEncoding) {
    requireCanonicalJcsEqual(
      snapshot.project,
      project,
      `Migrated revision ${revision} project`,
    );
  }
  const timeline = sanitizedTimeline(
    snapshot.timeline,
    project,
    revision,
    schemaPolicy,
  );
  if (requireCanonicalEncoding) {
    requireCanonicalJcsEqual(
      snapshot.timeline,
      timeline,
      `Migrated revision ${revision} timeline`,
    );
  }
  const transcript = requireMigrationProvenance
    ? validateMigratedCanonicalTranscript(
        snapshot.transcript,
        project,
        revision,
        timeline.duration_us,
      )
    : validateStandardCanonicalTranscript(
        snapshot.transcript,
        project,
        revision,
        timeline.duration_us,
        requireCanonicalEncoding,
      );
  const editBrief = requireMigrationProvenance
    ? validateMigratedCanonicalEditBrief(snapshot.edit_brief, project, revision)
    : validateStandardCanonicalEditBrief(
        snapshot.edit_brief,
        project,
        revision,
        requireCanonicalEncoding,
      );
  const visual =
    snapshot.visual_composition === undefined
      ? undefined
      : sanitizedVisual(
          snapshot.visual_composition,
          project.project_id,
          timeline.timeline_id,
          revision,
          timeline.duration_us,
          transcript,
        );
  if (visual && requireCanonicalEncoding) {
    requireCanonicalJcsEqual(
      snapshot.visual_composition,
      visual,
      `Migrated revision ${revision} visual composition`,
    );
  }
  const restoredFrom =
    snapshot.restored_from_revision === undefined
      ? undefined
      : requiredInteger(
          snapshot.restored_from_revision,
          `migrated revision ${revision} restore target`,
        );
  const canonical: LocalProjectSnapshot = {
    schema_version: "creatorcut-local-snapshot/1.0",
    revision,
    project,
    timeline,
    transcript,
    edit_brief: editBrief,
    ...(visual ? { visual_composition: visual } : {}),
    ...(restoredFrom === undefined
      ? {}
      : { restored_from_revision: restoredFrom }),
  };
  return requireCanonicalEncoding
    ? canonical
    : (structuredClone(snapshot) as unknown as LocalProjectSnapshot);
}

async function validateCanonicalPublicStateUnlocked(
  creatorcutDirectory: string,
  options: {
    migratedThroughRevision?: number;
    publicMutationRevisions?: ReadonlySet<number>;
    legacyOperationLogThroughRevision?: number | "current";
    requireCompleteHistoryFromZero?: boolean;
  } = {},
): Promise<{ projectId: string; revision: number }> {
  const migratedCanonical = options.migratedThroughRevision !== undefined;
  const requiresMigrationProvenance = (revision: number): boolean =>
    migratedCanonical &&
    revision <= options.migratedThroughRevision! &&
    !options.publicMutationRevisions?.has(revision);
  const [project, timeline, transcript, brief, history, rootVisual] =
    await Promise.all([
      readJson<LocalMediaProject>(join(creatorcutDirectory, "project.json")),
      readJson<LocalTimeline>(join(creatorcutDirectory, "timeline.json")),
      readJson<LocalTranscript>(join(creatorcutDirectory, "transcript.json")),
      readJson<LocalEditBrief>(join(creatorcutDirectory, "edit-brief.json")),
      readJson<LocalRevisionHistory>(join(creatorcutDirectory, "history.json")),
      readJson<LocalVisualComposition>(
        join(creatorcutDirectory, "visual-composition.json"),
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }),
    ]);
  if (
    typeof project.project_id !== "string" ||
    !Number.isSafeInteger(project.revision) ||
    timeline.project_id !== project.project_id ||
    transcript.project_id !== project.project_id ||
    brief.project_id !== project.project_id ||
    timeline.revision !== project.revision ||
    transcript.revision !== project.revision ||
    brief.base_revision !== project.revision ||
    history.current_revision !== project.revision ||
    !Array.isArray(history.undo_stack) ||
    !Array.isArray(history.redo_stack)
  ) {
    throw new TypeError(
      "CreatorCut canonical project revisions are inconsistent",
    );
  }
  if (!isRecord(history)) {
    throw new TypeError("CreatorCut history is invalid");
  }
  assertExactKeys(
    history as unknown as Record<string, unknown>,
    ["schema_version", "current_revision", "undo_stack", "redo_stack"],
    "CreatorCut history",
  );
  if (history.schema_version !== "creatorcut-local-history/1.0") {
    throw new TypeError("CreatorCut history schema is unsupported");
  }
  const versionNames = (await readdir(join(creatorcutDirectory, "versions")))
    .filter((name) => /^\d+\.json$/u.test(name))
    .sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
  const revisions = new Set(
    versionNames.map((name) => Number(name.slice(0, -5))),
  );
  if (
    (migratedCanonical || options.requireCompleteHistoryFromZero === true) &&
    (versionNames.length !== project.revision + 1 ||
      versionNames.some((name, index) => name !== `${index}.json`))
  ) {
    throw new TypeError(
      "CreatorCut canonical revision snapshots must contain complete history from revision 0",
    );
  }
  if (!revisions.has(project.revision)) {
    throw new TypeError("CreatorCut current revision snapshot is missing");
  }
  const snapshots = new Map<number, LocalProjectSnapshot>();
  for (const name of versionNames) {
    const revision = Number(name.slice(0, -5));
    const snapshot = await readJson<LocalProjectSnapshot>(
      join(creatorcutDirectory, "versions", name),
    );
    if (!isRecord(snapshot)) {
      throw new TypeError(
        `CreatorCut revision snapshot ${revision} is invalid`,
      );
    }
    assertAllowedKeys(
      snapshot as unknown as Record<string, unknown>,
      [
        "schema_version",
        "revision",
        "project",
        "timeline",
        "transcript",
        "edit_brief",
      ],
      [
        "schema_version",
        "revision",
        "project",
        "timeline",
        "transcript",
        "edit_brief",
        "visual_composition",
        "restored_from_revision",
      ],
      `CreatorCut revision snapshot ${revision}`,
    );
    if (
      snapshot.schema_version !== "creatorcut-local-snapshot/1.0" ||
      snapshot.revision !== revision ||
      snapshot.project?.project_id !== project.project_id ||
      snapshot.project?.revision !== revision ||
      snapshot.timeline?.project_id !== project.project_id ||
      snapshot.timeline?.revision !== revision ||
      snapshot.transcript?.project_id !== project.project_id ||
      snapshot.transcript?.revision !== revision ||
      snapshot.edit_brief?.project_id !== project.project_id ||
      snapshot.edit_brief?.base_revision !== revision ||
      (snapshot.visual_composition !== undefined &&
        (snapshot.visual_composition.project_id !== project.project_id ||
          snapshot.visual_composition.project_revision !== revision))
    ) {
      throw new TypeError(
        `CreatorCut revision snapshot ${revision} is inconsistent`,
      );
    }
    snapshots.set(
      revision,
      validateMigratedCanonicalSnapshot(
        snapshot,
        revision,
        requiresMigrationProvenance(revision),
        migratedCanonical,
      ),
    );
  }
  const rootSnapshot = validateMigratedCanonicalSnapshot(
    {
      schema_version: "creatorcut-local-snapshot/1.0",
      revision: project.revision,
      project,
      timeline,
      transcript,
      edit_brief: brief,
      ...(rootVisual ? { visual_composition: rootVisual } : {}),
    },
    project.revision,
    requiresMigrationProvenance(project.revision),
    migratedCanonical,
  );
  const currentSnapshot = snapshots.get(project.revision)!;
  for (const key of [
    "project",
    "timeline",
    "transcript",
    "edit_brief",
    "visual_composition",
  ] as const) {
    if (
      digestJcs(rootSnapshot[key] ?? null) !==
      digestJcs(currentSnapshot[key] ?? null)
    ) {
      throw new TypeError(
        `CreatorCut canonical current ${key} does not match its revision snapshot`,
      );
    }
  }
  const stackRevisions = [...history.undo_stack, ...history.redo_stack];
  if (
    stackRevisions.some(
      (revision) => !Number.isSafeInteger(revision) || !revisions.has(revision),
    ) ||
    new Set(stackRevisions).size !== stackRevisions.length
  ) {
    throw new TypeError(
      "CreatorCut history references invalid revision snapshots",
    );
  }
  const operations = parseJsonLines<LegacyCompatibleOperationLogEntry>(
    await readFile(join(creatorcutDirectory, "operations.jsonl"), "utf8"),
    "CreatorCut operation log",
  );
  const firstRevision = Math.min(...revisions);
  const legacyOperationLogThroughRevision =
    options.legacyOperationLogThroughRevision === "current"
      ? project.revision
      : options.legacyOperationLogThroughRevision;
  let previousResult = firstRevision;
  let replayUndo: number[] = [];
  let replayRedo: number[] = [];
  let sawTypedOperation = false;
  for (const operation of operations) {
    if (!isRecord(operation)) {
      throw new TypeError("CreatorCut operation log entry is invalid");
    }
    assertAllowedKeys(
      operation as unknown as Record<string, unknown>,
      [
        "schema_version",
        "revision",
        "base_revision",
        "operation_ids",
        "committed_at",
      ],
      [
        "schema_version",
        "kind",
        "revision",
        "base_revision",
        "operation_ids",
        "manifest_digest",
        "committed_at",
        "restored_from_revision",
      ],
      "CreatorCut operation log entry",
    );
    if (
      operation.schema_version !== "creatorcut-local-operation-log/1.0" ||
      (operation.kind !== undefined &&
        !["commit", "undo", "redo"].includes(operation.kind)) ||
      !Number.isSafeInteger(operation.base_revision) ||
      !Number.isSafeInteger(operation.revision) ||
      operation.revision !== operation.base_revision + 1 ||
      operation.base_revision !== previousResult ||
      !revisions.has(operation.revision) ||
      !Array.isArray(operation.operation_ids) ||
      operation.operation_ids.some(
        (id) => typeof id !== "string" || id.length === 0,
      )
    ) {
      throw new TypeError("CreatorCut operation chronology is invalid");
    }
    assertIsoDate(operation.committed_at, "Operation commit time");
    if (operation.manifest_digest !== undefined) {
      assertDigest(operation.manifest_digest, "Operation manifest digest");
    }
    const resultSnapshot =
      snapshots.get(operation.revision) ??
      (await readJson<LocalProjectSnapshot>(
        join(creatorcutDirectory, "versions", `${operation.revision}.json`),
      ));
    let operationKind = operation.kind;
    let restoredFromRevision = operation.restored_from_revision;
    const legacyOperation = operationKind === undefined;
    if (legacyOperation) {
      if (
        legacyOperationLogThroughRevision === undefined ||
        operation.revision > legacyOperationLogThroughRevision ||
        sawTypedOperation
      ) {
        throw new TypeError(
          "CreatorCut legacy operation log entry is not allowed here",
        );
      }
      if (restoredFromRevision !== undefined) {
        throw new TypeError(
          "Legacy CreatorCut operation cannot declare a restore target",
        );
      }
      const reservedLegacyOperationIds = operation.operation_ids.filter(
        (operationId) => /^local:(?:undo|redo):/u.test(operationId),
      );
      const soleLegacyOperationId =
        operation.operation_ids.length === 1
          ? operation.operation_ids[0]!
          : null;
      const legacyRestore =
        soleLegacyOperationId === null
          ? null
          : /^local:(undo|redo):(0|[1-9]\d*)$/u.exec(soleLegacyOperationId);
      if (
        reservedLegacyOperationIds.length > 0 &&
        (operation.operation_ids.length !== 1 || !legacyRestore)
      ) {
        throw new TypeError(
          "CreatorCut legacy restore operation ID is invalid",
        );
      }
      if (legacyRestore) {
        const candidateKind = legacyRestore[1] as "undo" | "redo";
        const candidateRevision = Number(legacyRestore[2]);
        const expectedTarget =
          candidateKind === "undo" ? replayUndo.at(-1) : replayRedo.at(-1);
        const targetSnapshot = snapshots.get(candidateRevision);
        if (
          candidateRevision === expectedTarget &&
          targetSnapshot &&
          legacyRestoreSnapshotMatches(
            resultSnapshot,
            targetSnapshot,
            operation.revision,
          )
        ) {
          operationKind = candidateKind;
          restoredFromRevision = candidateRevision;
        } else {
          throw new TypeError(
            "CreatorCut legacy restore operation does not match history and snapshot state",
          );
        }
      }
      operationKind ??= "commit";
    } else {
      sawTypedOperation = true;
    }
    if (operationKind === "undo" || operationKind === "redo") {
      if (
        !Number.isSafeInteger(restoredFromRevision) ||
        !revisions.has(restoredFromRevision!) ||
        (legacyOperation
          ? resultSnapshot.restored_from_revision !== undefined
          : resultSnapshot.restored_from_revision !== restoredFromRevision)
      ) {
        throw new TypeError("CreatorCut restore operation target is invalid");
      }
      if (legacyOperation) {
        const targetSnapshot = snapshots.get(restoredFromRevision!);
        if (
          !targetSnapshot ||
          !legacyRestoreSnapshotMatches(
            resultSnapshot,
            targetSnapshot,
            operation.revision,
          )
        ) {
          throw new TypeError(
            "CreatorCut legacy restore snapshot does not match its target",
          );
        }
      }
      const target =
        operationKind === "undo" ? replayUndo.at(-1) : replayRedo.at(-1);
      if (target !== restoredFromRevision) {
        throw new TypeError(
          "CreatorCut restore operation violates history transition",
        );
      }
      if (operationKind === "undo") {
        replayUndo = replayUndo.slice(0, -1);
        replayRedo = [...replayRedo, operation.base_revision];
      } else {
        replayUndo = [...replayUndo, operation.base_revision];
        replayRedo = replayRedo.slice(0, -1);
      }
    } else {
      if (
        restoredFromRevision !== undefined ||
        resultSnapshot.restored_from_revision !== undefined
      ) {
        throw new TypeError("CreatorCut commit cannot claim a restore target");
      }
      replayUndo = [...replayUndo, operation.base_revision];
      replayRedo = [];
    }
    previousResult = operation.revision;
  }
  if (previousResult !== project.revision) {
    throw new TypeError(
      "CreatorCut operation log does not reach current revision",
    );
  }
  if (
    replayUndo.length !== history.undo_stack.length ||
    replayUndo.some(
      (revision, index) => revision !== history.undo_stack[index],
    ) ||
    replayRedo.length !== history.redo_stack.length ||
    replayRedo.some((revision, index) => revision !== history.redo_stack[index])
  ) {
    throw new TypeError(
      "CreatorCut history does not match operation transitions",
    );
  }
  return { projectId: project.project_id, revision: project.revision };
}

function legacyRestoreSnapshotMatches(
  result: LocalProjectSnapshot,
  target: LocalProjectSnapshot,
  revision: number,
): boolean {
  const normalized: LocalProjectSnapshot = {
    ...structuredClone(target),
    revision,
    project: {
      ...structuredClone(target.project),
      revision,
      ...(result.project.updated_at === undefined
        ? {}
        : { updated_at: result.project.updated_at }),
    },
    timeline: { ...structuredClone(target.timeline), revision },
    transcript: { ...structuredClone(target.transcript), revision },
    edit_brief: {
      ...structuredClone(target.edit_brief),
      base_revision: revision,
    },
    ...(target.visual_composition
      ? {
          visual_composition: {
            ...structuredClone(target.visual_composition),
            project_revision: revision,
          },
        }
      : {}),
  };
  delete normalized.restored_from_revision;
  const comparable = structuredClone(result);
  delete comparable.restored_from_revision;
  return digestJcs(comparable) === digestJcs(normalized);
}

async function validateMarkerBindingUnlocked(
  creatorcutDirectory: string,
  marker: StorageAuthorityMarker,
): Promise<void> {
  for (const name of LEGACY_PRIVATE_STATE_FILES) {
    if (await pathExists(join(creatorcutDirectory, name))) {
      throw new Error(
        "Public authority cannot coexist with legacy private state",
      );
    }
  }
  const journal = await validateStorageMutationJournalUnlocked(
    creatorcutDirectory,
    marker,
  );
  const publicMutationRevisions = new Set(
    journal.slice(1).map((entry) => entry.project_revision),
  );
  const canonical = await validateCanonicalPublicStateUnlocked(
    creatorcutDirectory,
    marker.source_format === "creatorcut-internal-project-store/1.0-alpha"
      ? {
          migratedThroughRevision: marker.adopted_revision,
          publicMutationRevisions,
        }
      : {
          ...(journal[0]?.mutation_kind === "public_adopt"
            ? {
                legacyOperationLogThroughRevision: marker.adopted_revision,
                requireCompleteHistoryFromZero: true,
              }
            : {}),
        },
  );
  if (
    canonical.projectId !== marker.project_id ||
    canonical.revision !== marker.current_revision
  ) {
    throw new Error(
      "CreatorCut authority marker does not match current project",
    );
  }
  const currentDigest = await managedMetadataDigest(creatorcutDirectory);
  if (currentDigest !== marker.canonical_state_digest) {
    throw new Error(
      "CreatorCut authority marker does not match canonical state",
    );
  }
}

async function walkTree(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new TypeError(`Snapshot contains symbolic link: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(
        ...(await walkTree(join(directory, entry.name), relativePath)),
      );
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new TypeError(
        `Snapshot contains unsupported entry: ${relativePath}`,
      );
    }
  }
  return files.sort();
}

async function createMetadataTreeSnapshot(
  sourceDirectory: string,
  destinationDirectory: string,
  purpose: "transaction",
): Promise<MetadataTreeManifest> {
  await durableMkdir(destinationDirectory);
  const snapshot = await readMetadataSnapshot(sourceDirectory, purpose);
  for (const file of snapshot.files) {
    await atomicPrivateBuffer(
      join(destinationDirectory, file.relative_path),
      snapshot.contents.get(file.relative_path)!,
    );
  }
  const manifest: MetadataTreeManifest = {
    schema_version: "creatorcut-metadata-tree/1.1",
    files_digest: entriesDigest(snapshot.files),
    files: snapshot.files,
  };
  await syncDirectoryTree(destinationDirectory);
  await atomicPrivateJson(
    join(dirname(destinationDirectory), "snapshot.json"),
    manifest,
  );
  return manifest;
}

async function verifyMetadataTreeSnapshot(
  stageDirectory: string,
  pending?: PendingPublicMutation,
): Promise<{
  manifest: MetadataTreeManifest;
  contents: ReadonlyMap<string, Buffer>;
}> {
  const rootEntries = await readdir(stageDirectory, { withFileTypes: true });
  if (
    rootEntries.length !== 2 ||
    !rootEntries.some(
      (entry) =>
        entry.name === "before" &&
        entry.isDirectory() &&
        !entry.isSymbolicLink(),
    ) ||
    !rootEntries.some(
      (entry) =>
        entry.name === "snapshot.json" &&
        entry.isFile() &&
        !entry.isSymbolicLink(),
    )
  ) {
    throw new TypeError("Public mutation snapshot stage is not canonical");
  }
  const manifestBytes = await readMetadataBuffer(
    stageDirectory,
    "snapshot.json",
  );
  const parsed = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new TypeError("Public mutation snapshot manifest is invalid");
  }
  assertExactKeys(
    parsed,
    ["schema_version", "files_digest", "files"],
    "Public mutation snapshot manifest",
  );
  const manifest = parsed as unknown as MetadataTreeManifest;
  if (
    manifest.schema_version !== "creatorcut-metadata-tree/1.1" ||
    !Array.isArray(manifest.files)
  ) {
    throw new TypeError("Public mutation snapshot manifest is invalid");
  }
  assertDigest(manifest.files_digest, "Public mutation snapshot files digest");
  if (pending && digestJcs(manifest) !== pending.before_snapshot_digest) {
    throw new Error("Public mutation snapshot no longer matches pending WAL");
  }
  const before = join(stageDirectory, "before");
  const seen = new Set<string>();
  const contents = new Map<string, Buffer>();
  for (const file of manifest.files) {
    if (!isRecord(file)) {
      throw new TypeError("Public mutation snapshot file entry is invalid");
    }
    assertExactKeys(
      file,
      ["relative_path", "sha256", "size_bytes"],
      "Public mutation snapshot file entry",
    );
    safeRelativePath(file.relative_path);
    if (!isAllowedMetadataPath(file.relative_path, "transaction")) {
      throw new TypeError(
        `Public mutation snapshot path is not managed metadata: ${file.relative_path}`,
      );
    }
    if (
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(file.sha256) ||
      !Number.isSafeInteger(file.size_bytes) ||
      file.size_bytes < 0 ||
      file.size_bytes > MAX_METADATA_BYTES
    ) {
      throw new TypeError("Public mutation snapshot file entry is invalid");
    }
    if (seen.has(file.relative_path)) {
      throw new TypeError("Public mutation snapshot contains duplicate paths");
    }
    seen.add(file.relative_path);
    const fileContents = await readMetadataBuffer(before, file.relative_path);
    if (
      fileContents.byteLength !== file.size_bytes ||
      digest(fileContents).slice(7) !== file.sha256
    ) {
      throw new Error(
        `Public mutation snapshot digest mismatch: ${file.relative_path}`,
      );
    }
    contents.set(file.relative_path, fileContents);
  }
  if (entriesDigest(manifest.files) !== manifest.files_digest) {
    throw new Error("Public mutation snapshot file manifest digest mismatch");
  }
  const actual = await walkTree(before);
  if (actual.length !== seen.size || actual.some((path) => !seen.has(path))) {
    throw new Error("Public mutation snapshot contains unmanifested files");
  }
  return { manifest, contents };
}

async function restoreMetadataTreeSnapshot(
  creatorcutDirectory: string,
  stageDirectory: SafeCleanupDirectory,
  pending: PendingPublicMutation,
  verifiedSnapshot?: {
    manifest: MetadataTreeManifest;
    contents: ReadonlyMap<string, Buffer>;
  },
): Promise<void> {
  const verified =
    verifiedSnapshot ??
    (await verifyMetadataTreeSnapshot(stageDirectory, pending));
  const manifest = verified.manifest;
  const wanted = new Set(manifest.files.map((file) => file.relative_path));
  for (const relativePath of await collectManagedPathsForRestore(
    creatorcutDirectory,
  )) {
    if (!wanted.has(relativePath)) {
      await durableRemove(join(creatorcutDirectory, relativePath));
    }
  }
  for (const file of manifest.files) {
    await atomicPrivateBuffer(
      join(creatorcutDirectory, file.relative_path),
      verified.contents.get(file.relative_path)!,
    );
  }
  const restored = await metadataEntries(creatorcutDirectory, "transaction");
  if (!equalEntries(restored, manifest.files)) {
    throw new Error(
      "Public mutation rollback did not restore exact metadata bytes",
    );
  }
}

async function durableRemove(path: string): Promise<void> {
  await rm(path, { force: true });
  await syncDirectory(dirname(path));
}

async function durableAppendJsonLine(
  path: string,
  value: unknown,
): Promise<void> {
  const existing = await readFile(path).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return Buffer.alloc(0);
      throw error;
    },
  );
  await atomicPrivateBuffer(
    path,
    Buffer.concat([
      existing,
      Buffer.from(`${JSON.stringify(value)}\n`, "utf8"),
    ]),
  );
}

async function recoverPublicMutationUnlocked(
  creatorcutDirectory: string,
): Promise<void> {
  const pendingPath = join(creatorcutDirectory, PUBLIC_MUTATION_PENDING_FILE);
  if (!(await pathExists(pendingPath))) return;
  const pending = assertPublicMutationPending(await readJson(pendingPath));
  const stage = await safeMutationStageDirectory(
    creatorcutDirectory,
    pending.transaction_id,
  );
  let committed = false;
  const rawAuthority = await readJson<Record<string, unknown>>(
    join(creatorcutDirectory, AUTHORITY_FILE),
  ).catch(() => null);
  if (rawAuthority?.authority !== "public-runtime") {
    throw new Error(
      "Public mutation recovery cannot run after storage authority left public-runtime",
    );
  }
  const recoveryMarker = assertMarker(rawAuthority);
  if (
    recoveryMarker.project_id !== pending.project_id ||
    ![pending.base_generation, pending.expected_generation].includes(
      recoveryMarker.generation,
    ) ||
    (recoveryMarker.generation === pending.base_generation &&
      recoveryMarker.canonical_state_digest !==
        pending.base_canonical_state_digest)
  ) {
    throw new Error("Public mutation recovery authority binding changed");
  }
  try {
    const marker = assertMarker(rawAuthority);
    if (
      marker.project_id === pending.project_id &&
      marker.generation === pending.expected_generation
    ) {
      await validateMarkerBindingUnlocked(creatorcutDirectory, marker);
      const journal = parseJsonLines<Record<string, unknown>>(
        await readFile(
          join(creatorcutDirectory, MUTATION_JOURNAL_FILE),
          "utf8",
        ),
        "CreatorCut mutation journal",
      );
      const last = journal.at(-1);
      committed =
        last?.generation === marker.generation &&
        last.canonical_state_digest === marker.canonical_state_digest;
    }
  } catch {
    committed = false;
  }
  if (committed) {
    if (await pathExists(stage)) await removeSafeDirectory(stage);
    await durableRemove(pendingPath);
    return;
  }
  if (!(await pathExists(stage))) {
    throw new Error(
      "Public mutation recovery snapshot is missing before commit",
    );
  }
  const verifiedSnapshot = await verifyMetadataTreeSnapshot(stage, pending);
  await restoreMetadataTreeSnapshot(
    creatorcutDirectory,
    stage,
    pending,
    verifiedSnapshot,
  );
  await removeSafeDirectory(stage);
  await durableRemove(pendingPath);
}

async function removeEmptyPublicMutationWalUnlocked(
  creatorcutDirectory: string,
): Promise<void> {
  if (
    await pathExists(join(creatorcutDirectory, PUBLIC_MUTATION_PENDING_FILE))
  ) {
    throw new Error("Public mutation recovery remains pending");
  }
  const stagingRoot = await safeMutationStagingRoot(creatorcutDirectory);
  if (!(await pathExists(stagingRoot))) return;
  const entries = await readdir(stagingRoot);
  if (entries.length > 0) {
    throw new Error("Public mutation recovery contains unclaimed WAL state");
  }
  await removeSafeDirectory(stagingRoot);
  if (await pathExists(stagingRoot)) {
    throw new Error("Public mutation WAL cleanup did not complete");
  }
}

export async function validatePublicStorageAuthorityUnlocked(
  creatorcutDirectory: string,
): Promise<StorageAuthorityMarker> {
  const pendingAuthorityPath = join(creatorcutDirectory, PENDING_FILE);
  const authorityPath = join(creatorcutDirectory, AUTHORITY_FILE);
  if (!(await pathExists(authorityPath))) {
    if (await pathExists(pendingAuthorityPath)) {
      const pending = assertPending(await readJson(pendingAuthorityPath));
      await assertAuthorityStagingInventory(
        creatorcutDirectory,
        pending.migration_id,
      );
      throw new Error(
        "CreatorCut storage authority migration is pending; run project migrate-internal again",
      );
    }
    await assertAuthorityStagingInventory(creatorcutDirectory, null);
    if (await pathExists(join(creatorcutDirectory, MUTATION_JOURNAL_FILE))) {
      throw new Error(
        "CreatorCut storage authority metadata is incomplete; run project adopt-public --confirm-local to recover a verified interrupted adoption",
      );
    }
    if (await pathExists(join(creatorcutDirectory, LEGACY_HEAD_FILE))) {
      throw new Error(
        "CreatorCut project uses legacy internal storage; migrate before public status or mutations by running project migrate-internal",
      );
    }
    if (
      (
        await Promise.all(
          PUBLIC_ADOPTION_BLOCKERS.map((name) =>
            pathExists(join(creatorcutDirectory, name)),
          ),
        )
      ).some(Boolean)
    ) {
      throw new Error(
        "CreatorCut project contains legacy internal or pending storage and cannot be adopted as public",
      );
    }
    throw new Error(
      "CreatorCut project has unmarked public storage; run project adopt-public --confirm-local before public status or mutations",
    );
  }
  await recoverPublicMutationUnlocked(creatorcutDirectory);
  await removeEmptyPublicMutationWalUnlocked(creatorcutDirectory);
  if (await pathExists(pendingAuthorityPath)) {
    const pending = assertPending(await readJson(pendingAuthorityPath));
    await assertAuthorityStagingInventory(
      creatorcutDirectory,
      pending.migration_id,
    );
    throw new Error(
      "CreatorCut storage authority migration is pending; run project migrate-internal again",
    );
  }
  const raw = await readJson<Record<string, unknown>>(authorityPath);
  if (raw.authority !== "public-runtime") {
    await assertAuthorityStagingInventory(creatorcutDirectory, null);
    throw new Error(
      "CreatorCut project storage authority is internal-project-store; migrate before using public commands",
    );
  }
  const marker = assertMarker(raw);
  await assertAuthorityStagingInventory(
    creatorcutDirectory,
    marker.migration_id,
  );
  await validateMarkerBindingUnlocked(creatorcutDirectory, marker);
  if (marker.source_format === "creatorcut-internal-project-store/1.0-alpha") {
    await removeVerifiedCommittedAuthorityStage(creatorcutDirectory, marker);
  } else {
    await removeAuthorityStageAndEmptyRoot(
      creatorcutDirectory,
      marker.migration_id,
    );
  }
  await assertAuthorityStagingInventory(creatorcutDirectory, null);
  return marker;
}

export async function assertPublicStorageAuthority(
  creatorcutDirectory: string,
): Promise<StorageAuthorityMarker> {
  return withCreatorCutProjectLock(creatorcutDirectory, () =>
    validatePublicStorageAuthorityUnlocked(creatorcutDirectory),
  );
}

async function writeInitialMarker(
  creatorcutDirectory: string,
  input: {
    projectId: string;
    revision: number;
    generation: number;
    migrationId: string;
    sourceFormat: StorageAuthorityMarker["source_format"];
    backupManifestDigest: string;
    handoffSourceFilesDigest: string | null;
    handoffStageFilesDigest: string | null;
    initialMutationKind:
      "authority_handoff" | "project_create" | "public_adopt";
    now: Date;
    failureStage?: AuthorityMigrationFailureStage;
  },
): Promise<StorageAuthorityMarker> {
  if (input.initialMutationKind === "authority_handoff") {
    for (const name of NON_TRANSFERRED_RUNTIME_ARTIFACTS) {
      if (await pathExists(join(creatorcutDirectory, name))) {
        throw new Error(
          `Private runtime artifact must not cross storage authority: ${name}`,
        );
      }
    }
  }
  const timestamp = input.now.toISOString();
  const canonicalStateDigest = await managedMetadataDigest(creatorcutDirectory);
  const marker: StorageAuthorityMarker = {
    schema_version: "creatorcut-storage-authority/1.0",
    authority: "public-runtime",
    generation: input.generation,
    handoff_generation: input.generation,
    migration_id: input.migrationId,
    project_id: input.projectId,
    adopted_revision: input.revision,
    current_revision: input.revision,
    source_format: input.sourceFormat,
    backup_manifest_digest: input.backupManifestDigest,
    handoff_source_files_digest: input.handoffSourceFilesDigest,
    handoff_stage_files_digest: input.handoffStageFilesDigest,
    canonical_state_digest: canonicalStateDigest,
    activated_at: timestamp,
    updated_at: timestamp,
  };
  assertMarker(marker);
  const initialJournalEntry: StorageMutationJournalEntry = {
    schema_version: "creatorcut-storage-mutation/1.0",
    generation: input.generation,
    migration_id: input.migrationId,
    project_id: input.projectId,
    mutation_kind: input.initialMutationKind,
    project_revision: input.revision,
    canonical_state_digest: canonicalStateDigest,
    committed_at: timestamp,
  };
  assertStorageMutationJournalEntry(initialJournalEntry);
  inject(input.failureStage, "before_initial_journal");
  await atomicPrivateText(
    join(creatorcutDirectory, MUTATION_JOURNAL_FILE),
    `${JSON.stringify(initialJournalEntry)}\n`,
  );
  inject(input.failureStage, "after_initial_journal");
  inject(input.failureStage, "before_authority_marker");
  await atomicPrivateJson(join(creatorcutDirectory, AUTHORITY_FILE), marker);
  await validateStorageMutationJournalUnlocked(creatorcutDirectory, marker);
  return marker;
}

export async function initializePublicStorageAuthorityForCreate(
  creatorcutDirectory: string,
  projectId: string,
  revision: number,
  now = new Date(),
): Promise<StorageAuthorityMarker> {
  if (
    (await pathExists(join(creatorcutDirectory, AUTHORITY_FILE))) ||
    (await pathExists(join(creatorcutDirectory, PENDING_FILE))) ||
    (await pathExists(join(creatorcutDirectory, PUBLIC_MUTATION_PENDING_FILE)))
  ) {
    throw new Error("CreatorCut storage authority is already initialized");
  }
  const canonical =
    await validateCanonicalPublicStateUnlocked(creatorcutDirectory);
  if (canonical.projectId !== projectId || canonical.revision !== revision) {
    throw new Error("CreatorCut create authority binding mismatch");
  }
  return writeInitialMarker(creatorcutDirectory, {
    projectId,
    revision,
    generation: 0,
    migrationId: `native_${projectId}`,
    sourceFormat: "creatorcut-public-runtime/1.0",
    backupManifestDigest: digest("native-public-project"),
    handoffSourceFilesDigest: null,
    handoffStageFilesDigest: null,
    initialMutationKind: "project_create",
    now,
  });
}

export async function adoptLegacyPublicProject(
  projectDirectory: string,
  options: { confirmLocal: true; now?: Date },
): Promise<StorageAuthorityMarker> {
  if (options?.confirmLocal !== true) {
    throw new TypeError(
      "Explicit local public adoption confirmation is required",
    );
  }
  const directory = await realpath(resolve(projectDirectory));
  const creatorcutDirectory = join(directory, ".creatorcut");
  return withCreatorCutProjectLock(creatorcutDirectory, async () => {
    if (await pathExists(join(creatorcutDirectory, AUTHORITY_FILE))) {
      return validatePublicStorageAuthorityUnlocked(creatorcutDirectory);
    }
    for (const name of PUBLIC_ADOPTION_BLOCKERS) {
      if (await pathExists(join(creatorcutDirectory, name))) {
        throw new Error(
          "Internal or pending storage cannot be adopted as public",
        );
      }
    }
    await assertLegacyAdoptionAtomicTempsQuiescent(creatorcutDirectory);
    const canonical = await validateCanonicalPublicStateUnlocked(
      creatorcutDirectory,
      {
        legacyOperationLogThroughRevision: "current",
        requireCompleteHistoryFromZero: true,
      },
    );
    await assertLegacyAdoptionTasksCompleted(creatorcutDirectory);
    const migrationId = `adopt_${digest(JSON.stringify(canonical)).slice(7, 19)}`;
    const journalPath = join(creatorcutDirectory, MUTATION_JOURNAL_FILE);
    if (await pathExists(journalPath)) {
      const entries = parseJsonLines<unknown>(
        await readFile(journalPath, "utf8"),
        "CreatorCut mutation journal",
      ).map(assertStorageMutationJournalEntry);
      const entry = entries[0];
      const canonicalStateDigest =
        await managedMetadataDigest(creatorcutDirectory);
      if (
        entries.length !== 1 ||
        !entry ||
        entry.generation !== 0 ||
        entry.migration_id !== migrationId ||
        entry.project_id !== canonical.projectId ||
        entry.mutation_kind !== "public_adopt" ||
        entry.project_revision !== canonical.revision ||
        entry.canonical_state_digest !== canonicalStateDigest
      ) {
        throw new Error(
          "CreatorCut mutation journal cannot be reset by public adoption",
        );
      }
      const marker: StorageAuthorityMarker = {
        schema_version: "creatorcut-storage-authority/1.0",
        authority: "public-runtime",
        generation: 0,
        handoff_generation: 0,
        migration_id: migrationId,
        project_id: canonical.projectId,
        adopted_revision: canonical.revision,
        current_revision: canonical.revision,
        source_format: "creatorcut-public-runtime/1.0",
        backup_manifest_digest: digest("explicit-local-public-adoption"),
        handoff_source_files_digest: null,
        handoff_stage_files_digest: null,
        canonical_state_digest: canonicalStateDigest,
        activated_at: entry.committed_at,
        updated_at: entry.committed_at,
      };
      assertMarker(marker);
      await atomicPrivateJson(
        join(creatorcutDirectory, AUTHORITY_FILE),
        marker,
      );
      await validateMarkerBindingUnlocked(creatorcutDirectory, marker);
      return marker;
    }
    const marker = await writeInitialMarker(creatorcutDirectory, {
      projectId: canonical.projectId,
      revision: canonical.revision,
      generation: 0,
      migrationId,
      sourceFormat: "creatorcut-public-runtime/1.0",
      backupManifestDigest: digest("explicit-local-public-adoption"),
      handoffSourceFilesDigest: null,
      handoffStageFilesDigest: null,
      initialMutationKind: "public_adopt",
      now: options.now ?? new Date(),
    });
    await validateMarkerBindingUnlocked(creatorcutDirectory, marker);
    return marker;
  });
}

function injectPublicMutation(
  actual: PublicMutationFailureStage | undefined,
  expected: PublicMutationFailureStage,
): void {
  if (actual === expected) throw new Error(`Injected failure: ${expected}`);
}

export async function withPublicStorageMutation<T>(
  creatorcutDirectory: string,
  mutationKind: string,
  operation: (
    marker: StorageAuthorityMarker,
  ) => Promise<{ value: T; currentRevision: number }>,
  options: { failureStage?: PublicMutationFailureStage; now?: Date } = {},
): Promise<{ value: T; marker: StorageAuthorityMarker }> {
  assertIdentifier(mutationKind, "Mutation kind");
  return withCreatorCutProjectLock(creatorcutDirectory, async () => {
    const marker =
      await validatePublicStorageAuthorityUnlocked(creatorcutDirectory);
    const directorEffectPath = join(
      creatorcutDirectory,
      "tasks",
      "director-remote-effect.json",
    );
    const directorEffect = await readJson<Record<string, unknown>>(
      directorEffectPath,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (
      directorEffect !== null &&
      directorEffect.status !== "completed" &&
      ![
        "director_remote_effect",
        "director_state_write",
        "director_state_clear",
      ].includes(mutationKind)
    ) {
      throw new Error(
        "CreatorCut Director remote effect recovery must complete before another project mutation",
      );
    }
    const transactionId = `mutation_${randomUUID().replaceAll("-", "")}`;
    const stage = await safeMutationStageDirectory(
      creatorcutDirectory,
      transactionId,
    );
    await removeSafeDirectory(stage);
    let beforeSnapshot: MetadataTreeManifest;
    try {
      await durableMkdir(join(stage, "before"));
      beforeSnapshot = await createMetadataTreeSnapshot(
        creatorcutDirectory,
        join(stage, "before"),
        "transaction",
      );
    } catch (error) {
      await removeSafeDirectory(stage);
      throw error;
    }
    const pending: PendingPublicMutation = {
      schema_version: "creatorcut-public-mutation/1.1",
      transaction_id: transactionId,
      project_id: marker.project_id,
      base_revision: marker.current_revision,
      base_generation: marker.generation,
      expected_generation: marker.generation + 1,
      base_canonical_state_digest: marker.canonical_state_digest,
      before_snapshot_digest: digestJcs(beforeSnapshot),
      mutation_kind: mutationKind,
      created_at: (options.now ?? new Date()).toISOString(),
    };
    const pendingPath = join(creatorcutDirectory, PUBLIC_MUTATION_PENDING_FILE);
    injectPublicMutation(options.failureStage, "before_mutation_pending_write");
    await atomicPrivateJson(pendingPath, pending);
    injectPublicMutation(options.failureStage, "after_mutation_pending_write");
    let markerCommitted = false;
    try {
      const result = await operation(marker);
      injectPublicMutation(options.failureStage, "after_mutation_body");
      const journal = await validateStorageMutationJournalUnlocked(
        creatorcutDirectory,
        marker,
      );
      const publicMutationRevisions = new Set(
        journal.slice(1).map((entry) => entry.project_revision),
      );
      publicMutationRevisions.add(result.currentRevision);
      const canonical = await validateCanonicalPublicStateUnlocked(
        creatorcutDirectory,
        marker.source_format === "creatorcut-internal-project-store/1.0-alpha"
          ? {
              migratedThroughRevision: marker.adopted_revision,
              publicMutationRevisions,
            }
          : {
              ...(journal[0]?.mutation_kind === "public_adopt"
                ? {
                    legacyOperationLogThroughRevision: marker.adopted_revision,
                    requireCompleteHistoryFromZero: true,
                  }
                : {}),
            },
      );
      if (
        canonical.projectId !== marker.project_id ||
        canonical.revision !== result.currentRevision
      ) {
        throw new TypeError(
          "Public mutation result does not match canonical project state",
        );
      }
      const stateDigest = await managedMetadataDigest(creatorcutDirectory);
      const timestamp = (options.now ?? new Date()).toISOString();
      const next: StorageAuthorityMarker = {
        ...marker,
        generation: marker.generation + 1,
        current_revision: result.currentRevision,
        canonical_state_digest: stateDigest,
        updated_at: timestamp,
      };
      assertMarker(next);
      await durableAppendJsonLine(
        join(creatorcutDirectory, MUTATION_JOURNAL_FILE),
        {
          schema_version: "creatorcut-storage-mutation/1.0",
          generation: next.generation,
          migration_id: next.migration_id,
          project_id: next.project_id,
          mutation_kind: mutationKind,
          project_revision: result.currentRevision,
          canonical_state_digest: stateDigest,
          committed_at: timestamp,
        },
      );
      injectPublicMutation(options.failureStage, "after_mutation_journal");
      await atomicPrivateJson(join(creatorcutDirectory, AUTHORITY_FILE), next);
      markerCommitted = true;
      injectPublicMutation(options.failureStage, "after_mutation_marker");
      if (
        options.failureStage ===
        "after_mutation_pending_remove_before_stage_cleanup"
      ) {
        await durableRemove(pendingPath);
        injectPublicMutation(
          options.failureStage,
          "after_mutation_pending_remove_before_stage_cleanup",
        );
      }
      await removeSafeDirectory(stage);
      injectPublicMutation(
        options.failureStage,
        "after_mutation_stage_cleanup_before_pending_remove",
      );
      await durableRemove(pendingPath);
      return { value: result.value, marker: next };
    } catch (error) {
      const injected =
        error instanceof Error && error.message.startsWith("Injected failure:");
      if (!injected && !markerCommitted) {
        await restoreMetadataTreeSnapshot(creatorcutDirectory, stage, pending);
        await removeSafeDirectory(stage);
        await durableRemove(pendingPath);
      }
      throw error;
    }
  });
}

async function createOrVerifyBackup(
  creatorcutDirectory: string,
  backupDirectory: string,
  projectId: string,
  revision: number,
): Promise<{
  manifest: MetadataBackupManifest;
  manifestDigest: string;
  sourceFiles: MetadataBackupFile[];
}> {
  const backupRoot = await validateBackupRoot(
    creatorcutDirectory,
    backupDirectory,
  );
  if (await pathExists(backupRoot)) {
    const manifest = await verifyBackup(creatorcutDirectory, backupRoot);
    if (
      manifest.project_id !== projectId ||
      manifest.project_revision !== revision
    ) {
      throw new Error(
        "Existing migration backup is for another project revision",
      );
    }
    const currentEntries = await metadataEntries(creatorcutDirectory, "backup");
    if (!equalEntries(currentEntries, manifest.files)) {
      throw new Error(
        "Existing migration backup does not match current metadata bytes",
      );
    }
    return {
      manifest,
      manifestDigest: digest(JSON.stringify(manifest)),
      sourceFiles: currentEntries,
    };
  }
  const temporaryValue = `${backupRoot}.tmp-${process.pid}-${randomUUID()}`;
  const temporary = temporaryValue as SafeCleanupDirectory;
  if (temporaryValue === backupRoot || temporaryValue === resolve("/")) {
    throw new TypeError("Migration backup temporary path is unsafe");
  }
  try {
    const metadataDirectory = join(temporary, "metadata");
    await durableMkdir(metadataDirectory);
    const sourceSnapshot = await readMetadataSnapshot(
      creatorcutDirectory,
      "backup",
    );
    for (const file of sourceSnapshot.files) {
      const relativePath = file.relative_path;
      safeRelativePath(relativePath);
      const destination = join(metadataDirectory, relativePath);
      await atomicPrivateBuffer(
        destination,
        sourceSnapshot.contents.get(relativePath)!,
      );
    }
    const manifest: MetadataBackupManifest = {
      schema_version: "creatorcut-metadata-backup/1.0",
      project_id: projectId,
      project_revision: revision,
      created_at: new Date().toISOString(),
      files: sourceSnapshot.files,
    };
    await atomicPrivateJson(join(temporary, "manifest.json"), manifest);
    await syncDirectoryTree(temporary);
    const currentSnapshot = await readMetadataSnapshot(
      creatorcutDirectory,
      "backup",
    );
    if (!equalEntries(sourceSnapshot.files, currentSnapshot.files)) {
      throw new Error(
        "Source metadata changed while creating migration backup",
      );
    }
    await durableMkdir(dirname(backupRoot));
    await rename(temporary, backupRoot);
    await syncDirectory(dirname(backupRoot));
    await verifyBackup(creatorcutDirectory, backupRoot);
    const publishedSource = await metadataEntries(
      creatorcutDirectory,
      "backup",
    );
    if (!equalEntries(sourceSnapshot.files, publishedSource)) {
      throw new Error(
        "Source metadata changed before migration backup publication",
      );
    }
    return {
      manifest,
      manifestDigest: digest(JSON.stringify(manifest)),
      sourceFiles: sourceSnapshot.files,
    };
  } catch (error) {
    await removeSafeDirectory(temporary);
    throw error;
  }
}

async function readVerifiedBackupSnapshot(
  creatorcutDirectory: string,
  backupDirectory: string,
): Promise<VerifiedMetadataBackup> {
  const backupRoot = await validateBackupRoot(
    creatorcutDirectory,
    backupDirectory,
  );
  return readVerifiedBackupSnapshotAtRoot(backupRoot);
}

async function readVerifiedBackupSnapshotAtRoot(
  backupRoot: string,
): Promise<VerifiedMetadataBackup> {
  const trustedDirectories = await openTrustedDirectoryChain(
    backupRoot,
    join(backupRoot, "metadata"),
  );
  try {
    const manifest = JSON.parse(
      (await readMetadataBuffer(backupRoot, "manifest.json")).toString("utf8"),
    ) as MetadataBackupManifest;
    if (
      manifest.schema_version !== "creatorcut-metadata-backup/1.0" ||
      typeof manifest.project_id !== "string" ||
      !Number.isSafeInteger(manifest.project_revision) ||
      !Array.isArray(manifest.files) ||
      !isRecord(manifest) ||
      Object.keys(manifest).sort().join("|") !==
        [
          "created_at",
          "files",
          "project_id",
          "project_revision",
          "schema_version",
        ]
          .sort()
          .join("|")
    ) {
      throw new TypeError("CreatorCut metadata backup manifest is invalid");
    }
    const listed = new Set<string>();
    const contentsByPath = new Map<string, Buffer>();
    for (const file of manifest.files) {
      safeRelativePath(file.relative_path);
      if (listed.has(file.relative_path)) {
        throw new TypeError(`Duplicate backup path: ${file.relative_path}`);
      }
      listed.add(file.relative_path);
      const contents = await readMetadataBuffer(
        join(backupRoot, "metadata"),
        file.relative_path,
      );
      if (
        contents.byteLength !== file.size_bytes ||
        digest(contents).slice(7) !== file.sha256
      ) {
        throw new Error(
          `Metadata backup digest mismatch: ${file.relative_path}`,
        );
      }
      contentsByPath.set(file.relative_path, contents);
    }
    const actual = await walkTree(join(backupRoot, "metadata"));
    if (
      actual.length !== listed.size ||
      actual.some((relativePath) => !listed.has(relativePath))
    ) {
      throw new Error("Metadata backup contains unmanifested files");
    }
    await assertTrustedDirectoryChain(trustedDirectories);
    return { manifest, contents: contentsByPath };
  } finally {
    await closeTrustedDirectoryChain(trustedDirectories);
  }
}

function assertPendingBackupBinding(
  verified: VerifiedMetadataBackup,
  pending: PendingAuthorityMigration,
  message: string,
): void {
  if (
    digest(JSON.stringify(verified.manifest)) !==
      pending.backup_manifest_digest ||
    entriesDigest(verified.manifest.files) !== pending.source_manifest_digest
  ) {
    throw new Error(message);
  }
}

async function verifyBackup(
  creatorcutDirectory: string,
  backupDirectory: string,
): Promise<MetadataBackupManifest> {
  return (
    await readVerifiedBackupSnapshot(creatorcutDirectory, backupDirectory)
  ).manifest;
}

function requireLegacyHead(value: LegacyHead): LegacyHead {
  const snapshot = value?.snapshot;
  if (
    value.schema_version !== "1.0-alpha" ||
    snapshot?.schema_version !== "1.0-alpha" ||
    typeof snapshot.project?.project_id !== "string" ||
    !Number.isSafeInteger(snapshot.project.revision) ||
    snapshot.timeline?.project_id !== snapshot.project.project_id ||
    snapshot.timeline?.revision !== snapshot.project.revision ||
    value.history?.current_revision !== snapshot.project.revision ||
    !Array.isArray(value.history.undo_stack) ||
    !Array.isArray(value.history.redo_stack)
  ) {
    throw new TypeError("Legacy CreatorCut head is invalid");
  }
  return value;
}

function requiredRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

type LocalMetadataSchemaPolicy = "frozen-legacy" | "canonical";

function requireLocalMetadataSchema(
  value: unknown,
  label: string,
  policy: LocalMetadataSchemaPolicy,
): void {
  if (
    value !== "1.0" &&
    !(policy === "frozen-legacy" && value === "1.0-alpha")
  ) {
    throw new TypeError(`${label} schema is unsupported`);
  }
}

function optionalInteger(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new TypeError(
      `${label} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return Number(value);
}

function sanitizedProject(
  value: unknown,
  expectedRevision: number,
  schemaPolicy: LocalMetadataSchemaPolicy,
): LocalMediaProject {
  const source = requiredRecord(value, "legacy project");
  assertAllowedKeys(
    source,
    ["schema_version", "project_id", "name", "revision", "assets"],
    [
      "schema_version",
      "project_id",
      "name",
      "revision",
      "created_at",
      "updated_at",
      "assets",
    ],
    "Legacy project",
  );
  requireLocalMetadataSchema(
    source.schema_version,
    "Legacy project",
    schemaPolicy,
  );
  const assetsValue = source.assets;
  if (!Array.isArray(assetsValue) || assetsValue.length === 0) {
    throw new TypeError("Legacy project assets are missing");
  }
  const assetIds = new Set<string>();
  const assets = assetsValue.map((raw, index) => {
    const asset = requiredRecord(raw, `legacy asset ${index}`);
    assertAllowedKeys(
      asset,
      ["asset_id", "kind", "relative_path", "sha256", "duration_us"],
      [
        "asset_id",
        "kind",
        "relative_path",
        "sha256",
        "duration_us",
        "width",
        "height",
        "frame_rate",
        "has_video",
        "has_audio",
        "video_codec",
        "audio_codec",
        "audio_sample_rate",
        "audio_channels",
        "rotation_degrees",
        "color_primaries",
        "color_transfer",
        "color_space",
      ],
      `Legacy asset ${index}`,
    );
    const relativePath = requiredString(
      asset.relative_path,
      `legacy asset ${index} relative_path`,
    );
    safeAssetRelativePath(relativePath, schemaPolicy);
    const kind = requiredString(asset.kind, `legacy asset ${index} kind`);
    if (!["video", "audio", "image", "subtitle", "lut"].includes(kind)) {
      throw new TypeError(`Legacy asset ${index} kind is unsupported`);
    }
    const width = optionalInteger(asset.width, `legacy asset ${index} width`);
    const height = optionalInteger(
      asset.height,
      `legacy asset ${index} height`,
    );
    const frameRate =
      asset.frame_rate === undefined
        ? undefined
        : (() => {
            const frame = requiredRecord(
              asset.frame_rate,
              `legacy asset ${index} frame rate`,
            );
            assertExactKeys(
              frame,
              ["numerator", "denominator"],
              `Legacy asset ${index} frame rate`,
            );
            const numerator = requiredInteger(
              frame.numerator,
              `legacy asset ${index} frame numerator`,
            );
            const denominator = requiredInteger(
              frame.denominator,
              `legacy asset ${index} frame denominator`,
            );
            if (numerator === 0 || denominator === 0) {
              throw new TypeError("Legacy frame rate must be positive");
            }
            return { numerator, denominator };
          })();
    const optionalBoolean = (field: string): boolean | undefined => {
      const candidate = asset[field];
      if (candidate === undefined) return undefined;
      if (typeof candidate !== "boolean") {
        throw new TypeError(`legacy asset ${index} ${field} must be boolean`);
      }
      return candidate;
    };
    const optionalString = (field: string): string | undefined => {
      const candidate = asset[field];
      if (candidate === undefined) return undefined;
      return requiredString(candidate, `legacy asset ${index} ${field}`);
    };
    const hasVideo = optionalBoolean("has_video");
    const hasAudio = optionalBoolean("has_audio");
    const videoCodec = optionalString("video_codec");
    const audioCodec = optionalString("audio_codec");
    const sampleRate = optionalInteger(
      asset.audio_sample_rate,
      `legacy asset ${index} audio sample rate`,
    );
    const channels = optionalInteger(
      asset.audio_channels,
      `legacy asset ${index} audio channels`,
    );
    const rotation = optionalInteger(
      asset.rotation_degrees,
      `legacy asset ${index} rotation`,
      -360,
      360,
    );
    const colorPrimaries = optionalString("color_primaries");
    const colorTransfer = optionalString("color_transfer");
    const colorSpace = optionalString("color_space");
    const assetId = requiredString(asset.asset_id, `legacy asset ${index} id`);
    if (assetIds.has(assetId)) {
      throw new TypeError("Legacy project asset IDs must be unique");
    }
    assetIds.add(assetId);
    return {
      asset_id: assetId,
      kind: kind as "video" | "audio" | "image" | "subtitle" | "lut",
      relative_path: relativePath,
      sha256: requiredString(asset.sha256, `legacy asset ${index} digest`),
      duration_us: requiredInteger(
        asset.duration_us,
        `legacy asset ${index} duration`,
      ),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(frameRate ? { frame_rate: frameRate } : {}),
      ...(hasVideo === undefined ? {} : { has_video: hasVideo }),
      ...(hasAudio === undefined ? {} : { has_audio: hasAudio }),
      ...(videoCodec === undefined ? {} : { video_codec: videoCodec }),
      ...(audioCodec === undefined ? {} : { audio_codec: audioCodec }),
      ...(sampleRate === undefined ? {} : { audio_sample_rate: sampleRate }),
      ...(channels === undefined ? {} : { audio_channels: channels }),
      ...(rotation === undefined ? {} : { rotation_degrees: rotation }),
      ...(colorPrimaries === undefined
        ? {}
        : { color_primaries: colorPrimaries }),
      ...(colorTransfer === undefined ? {} : { color_transfer: colorTransfer }),
      ...(colorSpace === undefined ? {} : { color_space: colorSpace }),
    };
  });
  const revision = requiredInteger(source.revision, "legacy project revision");
  if (revision !== expectedRevision) {
    throw new TypeError("Legacy project revision does not match its filename");
  }
  return {
    schema_version: "1.0",
    project_id: requiredString(source.project_id, "legacy project id"),
    name: requiredString(source.name, "legacy project name"),
    revision,
    ...(source.created_at === undefined
      ? {}
      : {
          created_at: requiredString(
            source.created_at,
            "legacy project created_at",
          ),
        }),
    ...(source.updated_at === undefined
      ? {}
      : {
          updated_at: requiredString(
            source.updated_at,
            "legacy project updated_at",
          ),
        }),
    assets,
  };
}

function sanitizedTimeline(
  value: unknown,
  project: LocalMediaProject,
  expectedRevision: number,
  schemaPolicy: LocalMetadataSchemaPolicy,
): LocalTimeline {
  const source = requiredRecord(value, "legacy timeline");
  assertAllowedKeys(
    source,
    [
      "schema_version",
      "timeline_id",
      "project_id",
      "revision",
      "duration_us",
      "canvas",
      "tracks",
    ],
    [
      "schema_version",
      "timeline_id",
      "project_id",
      "revision",
      "duration_us",
      "timebase",
      "canvas",
      "caption_safe_area",
      "tracks",
      "captions",
      "effects",
    ],
    "Legacy timeline",
  );
  requireLocalMetadataSchema(
    source.schema_version,
    "Legacy timeline",
    schemaPolicy,
  );
  if (
    requiredString(source.project_id, "legacy timeline project_id") !==
      project.project_id ||
    requiredInteger(source.revision, "legacy timeline revision") !==
      expectedRevision
  ) {
    throw new TypeError(
      "Legacy timeline is stale or belongs to another project",
    );
  }
  const canvas = requiredRecord(source.canvas, "legacy timeline canvas");
  assertAllowedKeys(
    canvas,
    ["width", "height"],
    ["width", "height", "framing"],
    "Legacy canvas",
  );
  if (source.timebase !== undefined && source.timebase !== "microseconds") {
    throw new TypeError("Legacy timeline timebase is unsupported");
  }
  const duration = requiredInteger(
    source.duration_us,
    "legacy timeline duration",
  );
  if (!Array.isArray(source.tracks)) {
    throw new TypeError("Legacy timeline tracks are missing");
  }
  const assetById = new Map(
    project.assets.map((asset) => [asset.asset_id, asset]),
  );
  const trackIds = new Set<string>();
  const clipIds = new Set<string>();
  const clipTrackKinds = new Map<
    string,
    LocalTimeline["tracks"][number]["kind"]
  >();
  const tracks = source.tracks.map((rawTrack, trackIndex) => {
    const track = requiredRecord(rawTrack, `legacy track ${trackIndex}`);
    assertExactKeys(
      track,
      ["track_id", "kind", "clips"],
      `Legacy track ${trackIndex}`,
    );
    const kind = requiredString(track.kind, `legacy track ${trackIndex} kind`);
    if (
      !["video", "audio", "voiceover", "caption", "music", "overlay"].includes(
        kind,
      )
    ) {
      throw new TypeError(`Legacy track ${trackIndex} kind is unsupported`);
    }
    if (!Array.isArray(track.clips)) {
      throw new TypeError(`Legacy track ${trackIndex} clips are missing`);
    }
    const trackId = requiredString(
      track.track_id,
      `legacy track ${trackIndex} id`,
    );
    if (trackIds.has(trackId)) {
      throw new TypeError("Legacy timeline track IDs must be unique");
    }
    trackIds.add(trackId);
    return {
      track_id: trackId,
      kind: kind as LocalTimeline["tracks"][number]["kind"],
      clips: track.clips.map((rawClip, clipIndex) => {
        const clip = requiredRecord(
          rawClip,
          `legacy track ${trackIndex} clip ${clipIndex}`,
        );
        assertAllowedKeys(
          clip,
          [
            "clip_id",
            "asset_id",
            "source_start_us",
            "source_end_us",
            "timeline_start_us",
            "timeline_end_us",
          ],
          [
            "clip_id",
            "asset_id",
            "source_start_us",
            "source_end_us",
            "timeline_start_us",
            "timeline_end_us",
            "speed_numerator",
            "speed_denominator",
            "gain_millibels",
          ],
          `Legacy track ${trackIndex} clip ${clipIndex}`,
        );
        const sourceStart = requiredInteger(
          clip.source_start_us,
          "legacy clip source start",
        );
        const sourceEnd = requiredInteger(
          clip.source_end_us,
          "legacy clip source end",
        );
        const timelineStart = requiredInteger(
          clip.timeline_start_us,
          "legacy clip timeline start",
        );
        const timelineEnd = requiredInteger(
          clip.timeline_end_us,
          "legacy clip timeline end",
        );
        if (sourceEnd <= sourceStart || timelineEnd <= timelineStart) {
          throw new TypeError("Legacy clip ranges must have positive duration");
        }
        const clipId = requiredString(clip.clip_id, "legacy clip id");
        if (clipIds.has(clipId)) {
          throw new TypeError("Legacy timeline clip IDs must be unique");
        }
        clipIds.add(clipId);
        const assetId = requiredString(clip.asset_id, "legacy clip asset id");
        const asset = assetById.get(assetId);
        if (!asset) {
          throw new TypeError("Legacy timeline clip references unknown asset");
        }
        const visualTrack = kind === "video" || kind === "overlay";
        const audioTrack =
          kind === "audio" || kind === "voiceover" || kind === "music";
        const compatibleAsset = visualTrack
          ? asset.kind === "video" || asset.kind === "image"
          : audioTrack
            ? asset.kind === "video" || asset.kind === "audio"
            : kind === "caption" && asset.kind === "subtitle";
        if (!compatibleAsset) {
          throw new TypeError(
            "Legacy timeline clip asset type does not match its track",
          );
        }
        if (sourceEnd > asset.duration_us || timelineEnd > duration) {
          throw new TypeError("Legacy timeline clip range is out of bounds");
        }
        clipTrackKinds.set(
          clipId,
          kind as LocalTimeline["tracks"][number]["kind"],
        );
        const speedNumerator = optionalInteger(
          clip.speed_numerator,
          "legacy clip speed numerator",
        );
        const speedDenominator = optionalInteger(
          clip.speed_denominator,
          "legacy clip speed denominator",
        );
        if (speedNumerator === 0 || speedDenominator === 0) {
          throw new TypeError("Legacy clip speed ratio must be positive");
        }
        const gainMillibels = optionalInteger(
          clip.gain_millibels,
          "legacy clip gain",
          -96_000,
          24_000,
        );
        return {
          clip_id: clipId,
          asset_id: assetId,
          source_start_us: sourceStart,
          source_end_us: sourceEnd,
          timeline_start_us: timelineStart,
          timeline_end_us: timelineEnd,
          ...(speedNumerator === undefined
            ? {}
            : { speed_numerator: speedNumerator }),
          ...(speedDenominator === undefined
            ? {}
            : { speed_denominator: speedDenominator }),
          ...(gainMillibels === undefined
            ? {}
            : { gain_millibels: gainMillibels }),
        };
      }),
    };
  });
  const framing = isRecord(canvas.framing)
    ? (() => {
        assertExactKeys(
          canvas.framing as Record<string, unknown>,
          ["mode", "focus_x_millis", "focus_y_millis"],
          "Legacy canvas framing",
        );
        if (
          !["fit_blur", "center_crop"].includes(String(canvas.framing.mode))
        ) {
          throw new TypeError("Legacy canvas framing mode is unsupported");
        }
        const focusX = requiredInteger(
          canvas.framing.focus_x_millis,
          "legacy framing focus x",
        );
        const focusY = requiredInteger(
          canvas.framing.focus_y_millis,
          "legacy framing focus y",
        );
        if (focusX > 1000 || focusY > 1000) {
          throw new TypeError("Legacy canvas framing focus is out of range");
        }
        return {
          mode: canvas.framing.mode as "fit_blur" | "center_crop",
          focus_x_millis: focusX,
          focus_y_millis: focusY,
        };
      })()
    : undefined;
  if (canvas.framing !== undefined && !framing) {
    throw new TypeError("Legacy canvas framing must be an object");
  }
  const captionIds = new Set<string>();
  const captions =
    source.captions === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(source.captions)) {
            throw new TypeError("Legacy timeline captions must be an array");
          }
          return source.captions.map((rawCaption, index) => {
            const caption = requiredRecord(
              rawCaption,
              `legacy caption ${index}`,
            );
            assertAllowedKeys(
              caption,
              ["caption_id", "start_us", "end_us", "text"],
              ["caption_id", "start_us", "end_us", "text", "style_id"],
              `Legacy caption ${index}`,
            );
            const start = requiredInteger(
              caption.start_us,
              "legacy caption start",
            );
            const end = requiredInteger(caption.end_us, "legacy caption end");
            if (end <= start || end > duration) {
              throw new TypeError("Legacy caption range is invalid");
            }
            const captionId = requiredString(
              caption.caption_id,
              "legacy caption id",
            );
            if (captionIds.has(captionId)) {
              throw new TypeError("Legacy timeline caption IDs must be unique");
            }
            captionIds.add(captionId);
            return {
              caption_id: captionId,
              start_us: start,
              end_us: end,
              text: requiredString(caption.text, "legacy caption text"),
              ...(caption.style_id === undefined
                ? {}
                : {
                    style_id: requiredString(
                      caption.style_id,
                      "legacy caption style",
                    ),
                  }),
            };
          });
        })();
  const effectIds = new Set<string>();
  const effects =
    source.effects === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(source.effects)) {
            throw new TypeError("Legacy timeline effects must be an array");
          }
          return source.effects.map((rawEffect, index) => {
            const effect = requiredRecord(rawEffect, `legacy effect ${index}`);
            assertExactKeys(
              effect,
              [
                "effect_id",
                "type",
                "target_clip_id",
                "lut_asset_id",
                "intensity_millis",
              ],
              `Legacy effect ${index}`,
            );
            if (effect.type !== "lut") {
              throw new TypeError("Legacy timeline effect type is unsupported");
            }
            const intensity = requiredInteger(
              effect.intensity_millis,
              "legacy effect intensity",
            );
            if (intensity > 1000) {
              throw new TypeError("Legacy LUT intensity is out of range");
            }
            const effectId = requiredString(
              effect.effect_id,
              "legacy effect id",
            );
            if (effectIds.has(effectId)) {
              throw new TypeError("Legacy timeline effect IDs must be unique");
            }
            effectIds.add(effectId);
            const targetClipId = requiredString(
              effect.target_clip_id,
              "legacy effect target clip",
            );
            const targetTrackKind = clipTrackKinds.get(targetClipId);
            if (!targetTrackKind) {
              throw new TypeError(
                "Legacy timeline effect references unknown clip",
              );
            }
            if (targetTrackKind !== "video" && targetTrackKind !== "overlay") {
              throw new TypeError(
                "Legacy LUT effect target must be a visual clip",
              );
            }
            const lutAssetId = requiredString(
              effect.lut_asset_id,
              "legacy LUT asset",
            );
            if (assetById.get(lutAssetId)?.kind !== "lut") {
              throw new TypeError(
                "Legacy timeline effect references invalid LUT asset",
              );
            }
            return {
              effect_id: effectId,
              type: "lut" as const,
              target_clip_id: targetClipId,
              lut_asset_id: lutAssetId,
              intensity_millis: intensity,
            };
          });
        })();
  return {
    schema_version: "1.0",
    timeline_id: requiredString(source.timeline_id, "legacy timeline id"),
    project_id: project.project_id,
    revision: expectedRevision,
    duration_us: duration,
    timebase: "microseconds",
    canvas: {
      width: requiredInteger(canvas.width, "legacy canvas width"),
      height: requiredInteger(canvas.height, "legacy canvas height"),
      ...(framing ? { framing } : {}),
    },
    ...(source.caption_safe_area === undefined
      ? {}
      : (() => {
          const safeArea = requiredRecord(
            source.caption_safe_area,
            "legacy caption safe area",
          );
          assertExactKeys(
            safeArea,
            ["left_px", "right_px", "top_px", "bottom_px"],
            "Legacy caption safe area",
          );
          return {
            caption_safe_area: {
              left_px: requiredInteger(safeArea.left_px, "caption safe left"),
              right_px: requiredInteger(
                safeArea.right_px,
                "caption safe right",
              ),
              top_px: requiredInteger(safeArea.top_px, "caption safe top"),
              bottom_px: requiredInteger(
                safeArea.bottom_px,
                "caption safe bottom",
              ),
            },
          };
        })()),
    tracks,
    ...(captions ? { captions } : {}),
    ...(effects ? { effects } : {}),
  };
}

function migrationTranscript(
  value: unknown,
  project: LocalMediaProject,
  expectedRevision: number,
  timelineDurationUs: number,
  schemaPolicy: LocalMetadataSchemaPolicy,
  useSourceAssetDuration = false,
): LocalTranscript {
  const source = requiredRecord(value, "legacy transcript");
  assertAllowedKeys(
    source,
    [
      "schema_version",
      "transcript_id",
      "project_id",
      "revision",
      "language_mode",
      "segments",
    ],
    [
      "schema_version",
      "transcript_id",
      "project_id",
      "revision",
      "language_mode",
      "detected_language",
      "glossary",
      "segments",
      "silence_intervals",
    ],
    "Legacy transcript",
  );
  requireLocalMetadataSchema(
    source.schema_version,
    "Legacy transcript",
    schemaPolicy,
  );
  if (
    requiredString(source.project_id, "transcript project id") !==
    project.project_id
  ) {
    throw new TypeError("Legacy transcript belongs to another project");
  }
  const sourceRevision = requiredInteger(
    source.revision,
    "transcript revision",
  );
  if (sourceRevision > expectedRevision) {
    throw new TypeError("Legacy transcript is newer than the target revision");
  }
  if (!["zh", "en", "mixed", "auto"].includes(String(source.language_mode))) {
    throw new TypeError("Legacy transcript language mode is unsupported");
  }
  const sourceAssets = new Map(
    project.assets
      .filter((asset) => asset.kind === "video" || asset.kind === "audio")
      .map((asset) => [asset.asset_id, asset]),
  );
  if (!Array.isArray(source.segments)) {
    throw new TypeError("Legacy transcript segments must be an array");
  }
  const segmentIds = new Set<string>();
  const tokenIds = new Set<string>();
  const segments = source.segments.map((rawSegment, index) => {
    const segment = requiredRecord(
      rawSegment,
      `legacy transcript segment ${index}`,
    );
    assertAllowedKeys(
      segment,
      [
        "segment_id",
        "source_asset_id",
        "start_us",
        "end_us",
        "display_text",
        "tokens",
      ],
      [
        "segment_id",
        "source_asset_id",
        "start_us",
        "end_us",
        "raw_text",
        "display_text",
        "tokens",
      ],
      `Legacy transcript segment ${index}`,
    );
    const segmentId = requiredString(
      segment.segment_id,
      "transcript segment id",
    );
    assertIdentifier(segmentId, "Transcript segment ID");
    if (segmentIds.has(segmentId))
      throw new TypeError("Transcript segment IDs repeat");
    segmentIds.add(segmentId);
    const assetId = requiredString(
      segment.source_asset_id,
      "transcript source asset",
    );
    if (!sourceAssets.has(assetId))
      throw new TypeError("Transcript references unknown media");
    const start = requiredInteger(segment.start_us, "transcript segment start");
    const end = requiredInteger(segment.end_us, "transcript segment end");
    const rangeLimit = useSourceAssetDuration
      ? sourceAssets.get(assetId)!.duration_us
      : timelineDurationUs;
    if (end <= start || end > rangeLimit) {
      throw new TypeError("Transcript segment range is invalid");
    }
    if (!Array.isArray(segment.tokens)) {
      throw new TypeError("Transcript segment tokens must be an array");
    }
    const tokens = segment.tokens.map((rawToken, tokenIndex) => {
      const token = requiredRecord(rawToken, `transcript token ${tokenIndex}`);
      assertExactKeys(
        token,
        ["token_id", "text", "start_us", "end_us", "language", "confidence"],
        `Transcript token ${tokenIndex}`,
      );
      const tokenId = requiredString(token.token_id, "transcript token id");
      assertIdentifier(tokenId, "Transcript token ID");
      if (tokenIds.has(tokenId))
        throw new TypeError("Transcript token IDs repeat");
      tokenIds.add(tokenId);
      const tokenStart = requiredInteger(
        token.start_us,
        "transcript token start",
      );
      const tokenEnd = requiredInteger(token.end_us, "transcript token end");
      if (tokenEnd <= tokenStart || tokenStart < start || tokenEnd > end) {
        throw new TypeError("Transcript token range is invalid");
      }
      if (!["zh", "en", "other"].includes(String(token.language))) {
        throw new TypeError("Transcript token language is unsupported");
      }
      if (
        typeof token.confidence !== "number" ||
        !Number.isFinite(token.confidence) ||
        token.confidence < 0 ||
        token.confidence > 1
      ) {
        throw new TypeError("Transcript token confidence is invalid");
      }
      return {
        token_id: tokenId,
        text: requiredString(token.text, "transcript token text"),
        start_us: tokenStart,
        end_us: tokenEnd,
        language: token.language as "zh" | "en" | "other",
        confidence: token.confidence,
      };
    });
    return {
      segment_id: segmentId,
      source_asset_id: assetId,
      start_us: start,
      end_us: end,
      display_text: requiredString(
        segment.display_text,
        "transcript display text",
      ),
      ...(segment.raw_text === undefined
        ? {}
        : {
            raw_text: requiredString(segment.raw_text, "transcript raw text"),
          }),
      tokens,
    };
  });
  const detectedLanguage =
    source.detected_language === undefined
      ? undefined
      : requiredString(
          source.detected_language,
          "transcript detected language",
        );
  if (
    detectedLanguage !== undefined &&
    !["zh", "en", "mixed", "other"].includes(detectedLanguage)
  ) {
    throw new TypeError("Transcript detected language is unsupported");
  }
  const glossary =
    source.glossary === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(source.glossary)) {
            throw new TypeError("Transcript glossary must be an array");
          }
          return source.glossary.map((entry) =>
            requiredString(entry, "glossary entry"),
          );
        })();
  const silenceIntervals =
    source.silence_intervals === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(source.silence_intervals)) {
            throw new TypeError(
              "Transcript silence intervals must be an array",
            );
          }
          const silenceIds = new Set<string>();
          return source.silence_intervals.map((rawInterval, index) => {
            const interval = requiredRecord(
              rawInterval,
              `silence interval ${index}`,
            );
            assertAllowedKeys(
              interval,
              ["silence_id", "source_asset_id", "start_us", "end_us"],
              [
                "silence_id",
                "source_asset_id",
                "start_us",
                "end_us",
                "detector",
              ],
              `Silence interval ${index}`,
            );
            const sourceAssetId = requiredString(
              interval.source_asset_id,
              "silence source asset",
            );
            if (!sourceAssets.has(sourceAssetId)) {
              throw new TypeError("Silence interval references unknown media");
            }
            const start = requiredInteger(interval.start_us, "silence start");
            const end = requiredInteger(interval.end_us, "silence end");
            const rangeLimit = useSourceAssetDuration
              ? sourceAssets.get(sourceAssetId)!.duration_us
              : timelineDurationUs;
            if (end <= start || end > rangeLimit) {
              throw new TypeError("Silence interval range is invalid");
            }
            if (
              interval.detector !== undefined &&
              interval.detector !== "ffmpeg_silencedetect"
            ) {
              throw new TypeError("Silence detector is unsupported");
            }
            const silenceId = requiredString(interval.silence_id, "silence id");
            if (silenceIds.has(silenceId)) {
              throw new TypeError("Transcript silence IDs repeat");
            }
            silenceIds.add(silenceId);
            return {
              silence_id: silenceId,
              source_asset_id: sourceAssetId,
              start_us: start,
              end_us: end,
              ...(interval.detector === undefined
                ? {}
                : { detector: "ffmpeg_silencedetect" as const }),
            };
          });
        })();
  return {
    schema_version: "1.0",
    transcript_id: requiredString(source.transcript_id, "transcript id"),
    project_id: project.project_id,
    revision: expectedRevision,
    language_mode: source.language_mode as LocalTranscript["language_mode"],
    ...(detectedLanguage === undefined
      ? {}
      : {
          detected_language: detectedLanguage as
            "zh" | "en" | "mixed" | "other",
        }),
    ...(glossary ? { glossary } : {}),
    migration_status: "preserved",
    source_revision: sourceRevision,
    segments,
    ...(silenceIntervals ? { silence_intervals: silenceIntervals } : {}),
  };
}

function placeholderTranscript(
  project: LocalMediaProject,
  revision: number,
  current: boolean,
): LocalTranscript {
  return {
    schema_version: "1.0",
    transcript_id: `transcript:${project.project_id}:migration-placeholder:${revision}`,
    project_id: project.project_id,
    revision,
    language_mode: "auto",
    migration_status: current ? "missing_current" : "missing_historical",
    segments: [],
    silence_intervals: [],
  };
}

function migrationEditBrief(
  value: unknown,
  project: LocalMediaProject,
  expectedRevision: number,
  schemaPolicy: LocalMetadataSchemaPolicy,
): LocalEditBrief {
  const source = requiredRecord(value, "legacy edit brief");
  assertAllowedKeys(
    source,
    [
      "schema_version",
      "brief_id",
      "project_id",
      "base_revision",
      "card_answer_digest",
      "platform",
      "target_duration_mode",
      "editing_intensity",
      "audio_mode",
      "must_keep_option_ids",
      "terms",
      "caption_style_id",
      "voice_id",
      "approved",
      "source_facts",
      "prefilled_card_ids",
      "created_at",
      "updated_at",
    ],
    [
      "schema_version",
      "brief_id",
      "project_id",
      "base_revision",
      "card_answer_digest",
      "platform",
      "target_duration_mode",
      "target_duration_us",
      "editing_intensity",
      "audio_mode",
      "must_keep_option_ids",
      "terms",
      "caption_style_id",
      "voice_id",
      "approved",
      "source_facts",
      "prefilled_card_ids",
      "created_at",
      "updated_at",
    ],
    "Legacy edit brief",
  );
  requireLocalMetadataSchema(
    source.schema_version,
    "Legacy edit brief",
    schemaPolicy,
  );
  if (
    requiredString(source.project_id, "edit brief project id") !==
    project.project_id
  ) {
    throw new TypeError("Legacy edit brief belongs to another project");
  }
  const sourceBaseRevision = requiredInteger(
    source.base_revision,
    "edit brief base revision",
  );
  if (sourceBaseRevision > expectedRevision) {
    throw new TypeError("Legacy edit brief is newer than the target revision");
  }
  if (typeof source.approved !== "boolean") {
    throw new TypeError("Legacy edit brief approved must be boolean");
  }
  const sourceFacts = requiredRecord(
    source.source_facts,
    "edit brief source facts",
  );
  assertExactKeys(
    sourceFacts,
    ["source_duration_us", "language_mode", "has_video", "has_audio"],
    "Legacy edit brief source facts",
  );
  const stringArray = (candidate: unknown, label: string): string[] => {
    if (!Array.isArray(candidate))
      throw new TypeError(`${label} must be an array`);
    return candidate.map((entry) => requiredString(entry, label));
  };
  const targetMode = requiredString(
    source.target_duration_mode,
    "target duration mode",
  );
  if (!["keep_original", "seconds"].includes(targetMode)) {
    throw new TypeError("Edit brief target duration mode is unsupported");
  }
  const targetDuration = optionalInteger(
    source.target_duration_us,
    "edit brief target duration",
  );
  if (targetMode === "seconds" && targetDuration === undefined) {
    throw new TypeError("Edit brief target duration is missing");
  }
  if (targetMode === "keep_original" && targetDuration !== undefined) {
    throw new TypeError("Edit brief keep-original mode cannot set duration");
  }
  const platform = requiredString(source.platform, "edit brief platform");
  const intensity = requiredString(
    source.editing_intensity,
    "editing intensity",
  );
  const audioMode = requiredString(source.audio_mode, "edit brief audio mode");
  if (!["xiaohongshu", "youtube", "linkedin", "generic"].includes(platform)) {
    throw new TypeError("Edit brief platform is unsupported");
  }
  if (!["natural", "tight", "story"].includes(intensity)) {
    throw new TypeError("Edit brief editing intensity is unsupported");
  }
  if (
    !["original", "partial_voiceover", "full_voiceover"].includes(audioMode)
  ) {
    throw new TypeError("Edit brief audio mode is unsupported");
  }
  if (
    typeof sourceFacts.has_video !== "boolean" ||
    typeof sourceFacts.has_audio !== "boolean"
  ) {
    throw new TypeError("Edit brief source media flags must be boolean");
  }
  return {
    schema_version: "1.0",
    brief_id: requiredString(source.brief_id, "edit brief id"),
    project_id: project.project_id,
    base_revision: expectedRevision,
    card_answer_digest: requiredString(
      source.card_answer_digest,
      "card answer digest",
    ),
    platform,
    target_duration_mode: targetMode,
    ...(targetDuration === undefined
      ? {}
      : { target_duration_us: targetDuration }),
    editing_intensity: intensity,
    audio_mode: audioMode as LocalEditBrief["audio_mode"],
    must_keep_option_ids: stringArray(
      source.must_keep_option_ids,
      "must keep option",
    ),
    terms: stringArray(source.terms, "edit brief term"),
    caption_style_id: requiredString(
      source.caption_style_id,
      "caption style id",
    ),
    voice_id: requiredString(source.voice_id, "voice id"),
    approved: source.approved,
    source_facts: {
      source_duration_us: requiredInteger(
        sourceFacts.source_duration_us,
        "source duration",
      ),
      language_mode: requiredString(
        sourceFacts.language_mode,
        "source language mode",
      ),
      has_video: sourceFacts.has_video,
      has_audio: sourceFacts.has_audio,
    },
    prefilled_card_ids: stringArray(
      source.prefilled_card_ids,
      "prefilled card id",
    ),
    created_at: requiredString(source.created_at, "edit brief created_at"),
    updated_at: requiredString(source.updated_at, "edit brief updated_at"),
    migration_status: "preserved",
    source_base_revision: sourceBaseRevision,
  };
}

function placeholderEditBrief(
  project: LocalMediaProject,
  revision: number,
  current: boolean,
): LocalEditBrief {
  return {
    schema_version: "1.0",
    brief_id: `brief:${project.project_id}:migration-placeholder:${revision}`,
    project_id: project.project_id,
    base_revision: revision,
    audio_mode: "original",
    caption_style_id: "caption_none",
    approved: false,
    migration_status: current ? "missing_current" : "missing_historical",
  };
}

function sanitizedVisual(
  value: unknown,
  projectId: string,
  timelineId: string,
  revision: number,
  timelineDurationUs: number,
  transcript?: LocalTranscript,
  allowedStates: ReadonlyArray<"active" | "needs_rebase" | "candidate"> = [
    "active",
    "needs_rebase",
  ],
): LocalVisualComposition {
  const source = requiredRecord(value, "legacy visual composition");
  assertExactKeys(
    source,
    [
      "schema_version",
      "composition_id",
      "project_id",
      "timeline_id",
      "rough_cut_revision",
      "project_revision",
      "state",
      "visual_catalog_version",
      "visual_catalog_digest",
      "visual_events",
      "provenance",
      "created_at",
      "updated_at",
    ],
    "Legacy visual composition",
  );
  if (source.schema_version !== "creatorcut-visual-composition/1.0") {
    throw new TypeError("Legacy visual composition schema is unsupported");
  }
  const compositionId = requiredString(
    source.composition_id,
    "visual composition id",
  );
  assertIdentifier(compositionId, "Visual composition ID");
  const roughCutRevision = requiredInteger(
    source.rough_cut_revision,
    "visual rough cut revision",
  );
  const catalogDigest = requiredString(
    source.visual_catalog_digest,
    "visual catalog digest",
  );
  assertDigest(catalogDigest, "Visual catalog digest");
  if (
    requiredString(source.project_id, "visual project id") !== projectId ||
    requiredString(source.timeline_id, "visual timeline id") !== timelineId ||
    requiredInteger(source.project_revision, "visual project revision") !==
      revision ||
    !allowedStates.includes(
      String(source.state) as "active" | "needs_rebase" | "candidate",
    ) ||
    !Array.isArray(source.visual_events)
  ) {
    throw new TypeError("Legacy visual composition is invalid or stale");
  }
  const provenance = requiredRecord(source.provenance, "visual provenance");
  assertExactKeys(
    provenance,
    ["fine_cut_chain_id", "answer_digest", "origin"],
    "Visual provenance",
  );
  const fineCutChainId = requiredString(
    provenance.fine_cut_chain_id,
    "fine cut chain id",
  );
  assertIdentifier(fineCutChainId, "Fine cut chain ID");
  const answerDigest = requiredString(
    provenance.answer_digest,
    "answer digest",
  );
  assertDigest(answerDigest, "Fine cut answer digest");
  if (
    !["local_rule", "private_director", "manual"].includes(
      String(provenance.origin),
    )
  ) {
    throw new TypeError("Visual provenance origin is unsupported");
  }
  const segmentRefs = new Set(
    transcript?.segments.map((segment) => segment.segment_id),
  );
  const tokenRefs = new Set(
    transcript?.segments.flatMap((segment) =>
      segment.tokens.map((token) => token.token_id),
    ),
  );
  let previousStart = -1;
  const eventIds = new Set<string>();
  const visualEvents = source.visual_events.map((rawEvent, index) => {
    const event = requiredRecord(rawEvent, `visual event ${index}`);
    assertExactKeys(
      event,
      [
        "visual_event_id",
        "base_revision",
        "anchor",
        "resolved_range",
        "visual_intent",
        "template_ref",
        "bindings",
        "risk",
        "confidence_millis",
        "enabled",
      ],
      `Visual event ${index}`,
    );
    const range = requiredRecord(event.resolved_range, "visual resolved range");
    assertExactKeys(range, ["start_us", "end_us"], "Visual resolved range");
    const template = requiredRecord(event.template_ref, "visual template ref");
    assertExactKeys(
      template,
      ["catalog_version", "catalog_digest", "template_id", "template_digest"],
      "Visual template reference",
    );
    const bindings = requiredRecord(event.bindings, "visual bindings");
    assertExactKeys(bindings, ["text", "accent"], "Visual bindings");
    const anchor = requiredRecord(event.anchor, "visual anchor");
    const anchorKind = requiredString(anchor.kind, "visual anchor kind");
    const eventId = requiredString(event.visual_event_id, "visual event id");
    assertIdentifier(eventId, "Visual event ID");
    if (eventIds.has(eventId))
      throw new TypeError("Visual event IDs must be unique");
    eventIds.add(eventId);
    const baseRevision = requiredInteger(
      event.base_revision,
      "visual base revision",
    );
    if (baseRevision !== roughCutRevision) {
      throw new TypeError(
        "Visual event is bound to the wrong rough cut revision",
      );
    }
    let sanitizedAnchor: Record<string, unknown>;
    if (anchorKind === "timeline_range") {
      assertExactKeys(anchor, ["kind", "origin"], "Visual timeline anchor");
      if (anchor.origin !== "manual") {
        throw new TypeError("Visual timeline anchor origin is unsupported");
      }
      sanitizedAnchor = { kind: "timeline_range", origin: "manual" };
    } else if (anchorKind === "transcript_span") {
      assertExactKeys(
        anchor,
        ["kind", "segment_refs", "token_refs"],
        "Visual transcript anchor",
      );
      if (
        !Array.isArray(anchor.segment_refs) ||
        !Array.isArray(anchor.token_refs)
      ) {
        throw new TypeError("Visual transcript anchor evidence must be arrays");
      }
      const segments = anchor.segment_refs.map((entry) => {
        const id = requiredString(entry, "segment ref");
        assertIdentifier(id, "Visual segment reference");
        return id;
      });
      const tokens = anchor.token_refs.map((entry) => {
        const id = requiredString(entry, "token ref");
        assertIdentifier(id, "Visual token reference");
        return id;
      });
      if (segments.length + tokens.length === 0) {
        throw new TypeError("Visual transcript anchor requires evidence");
      }
      if (
        !transcript ||
        segments.some((id) => !segmentRefs.has(id)) ||
        tokens.some((id) => !tokenRefs.has(id))
      ) {
        throw new TypeError("Visual transcript anchor evidence is missing");
      }
      sanitizedAnchor = {
        kind: "transcript_span",
        segment_refs: segments,
        token_refs: tokens,
      };
    } else {
      throw new TypeError("Visual anchor kind is unsupported");
    }
    const startUs = requiredInteger(range.start_us, "visual range start");
    const endUs = requiredInteger(range.end_us, "visual range end");
    if (
      endUs <= startUs ||
      endUs > timelineDurationUs ||
      startUs < previousStart
    ) {
      throw new TypeError("Visual event range is invalid or out of order");
    }
    previousStart = startUs;
    if (!["hook", "emphasis"].includes(String(event.visual_intent))) {
      throw new TypeError("Visual intent is unsupported");
    }
    if (
      template.catalog_version !== "creatorcut-visual-catalog/1.0" ||
      template.template_id !== "keyword_pulse_v1"
    ) {
      throw new TypeError("Visual template is unsupported");
    }
    const templateCatalogDigest = requiredString(
      template.catalog_digest,
      "catalog digest",
    );
    const templateDigest = requiredString(
      template.template_digest,
      "template digest",
    );
    assertDigest(templateCatalogDigest, "Visual event catalog digest");
    assertDigest(templateDigest, "Visual template digest");
    if (templateCatalogDigest !== catalogDigest) {
      throw new TypeError(
        "Visual event catalog digest does not match composition",
      );
    }
    const text = requiredString(bindings.text, "visual binding text");
    if ([...text].length > 80 || /[{}\\\r\n]/u.test(text)) {
      throw new TypeError("Visual text binding is unsafe");
    }
    if (
      !["creator_purple", "signal_yellow", "clean_white"].includes(
        String(bindings.accent),
      )
    ) {
      throw new TypeError("Visual accent is unsupported");
    }
    if (event.risk !== "low") throw new TypeError("Visual risk is unsupported");
    const confidence = requiredInteger(
      event.confidence_millis,
      "visual confidence",
    );
    if (confidence > 1000)
      throw new TypeError("Visual confidence is out of range");
    if (typeof event.enabled !== "boolean") {
      throw new TypeError("Visual enabled must be boolean");
    }
    return {
      visual_event_id: eventId,
      base_revision: baseRevision,
      anchor: sanitizedAnchor,
      resolved_range: { start_us: startUs, end_us: endUs },
      visual_intent: event.visual_intent,
      template_ref: {
        catalog_version: template.catalog_version,
        catalog_digest: templateCatalogDigest,
        template_id: template.template_id,
        template_digest: templateDigest,
      },
      bindings: { text, accent: bindings.accent },
      risk: "low",
      confidence_millis: confidence,
      enabled: event.enabled,
    };
  });
  const createdAt = requiredString(source.created_at, "visual created_at");
  const updatedAt = requiredString(source.updated_at, "visual updated_at");
  assertIsoDate(createdAt, "Visual created_at");
  assertIsoDate(updatedAt, "Visual updated_at");
  if (source.visual_catalog_version !== "creatorcut-visual-catalog/1.0") {
    throw new TypeError("Visual catalog version is unsupported");
  }
  return {
    schema_version: "creatorcut-visual-composition/1.0",
    composition_id: compositionId,
    project_id: projectId,
    timeline_id: timelineId,
    rough_cut_revision: roughCutRevision,
    project_revision: revision,
    state: source.state as LocalVisualComposition["state"],
    visual_catalog_version: "creatorcut-visual-catalog/1.0",
    visual_catalog_digest: catalogDigest,
    visual_events: visualEvents,
    provenance: {
      fine_cut_chain_id: fineCutChainId,
      answer_digest: answerDigest,
      origin: provenance.origin,
    },
    created_at: createdAt,
    updated_at: updatedAt,
  } as unknown as LocalVisualComposition;
}

function publicSnapshot(
  snapshot: LegacySnapshot,
  expectedRevision: number,
  artifacts: {
    transcript?: unknown;
    editBrief?: unknown;
    current?: boolean;
  } = {},
): LocalProjectSnapshot {
  assertAllowedKeys(
    snapshot as unknown as Record<string, unknown>,
    ["schema_version", "project", "timeline"],
    [
      "schema_version",
      "project",
      "timeline",
      "transcript",
      "edit_brief",
      "visual_composition",
      "restored_from_revision",
    ],
    "Legacy project snapshot",
  );
  const project = sanitizedProject(
    snapshot.project,
    expectedRevision,
    "frozen-legacy",
  );
  const timeline = sanitizedTimeline(
    snapshot.timeline,
    project,
    expectedRevision,
    "frozen-legacy",
  );
  const revision = expectedRevision;
  if (
    snapshot.timeline.project_id !== snapshot.project.project_id ||
    snapshot.timeline.revision !== revision
  ) {
    throw new TypeError(
      "Legacy snapshot project and timeline revisions differ",
    );
  }
  const transcriptSource = snapshot.transcript ?? artifacts.transcript;
  const transcript =
    transcriptSource === undefined
      ? placeholderTranscript(project, revision, artifacts.current === true)
      : migrationTranscript(
          transcriptSource,
          project,
          revision,
          timeline.duration_us,
          "frozen-legacy",
        );
  const editBriefSource = snapshot.edit_brief ?? artifacts.editBrief;
  const editBrief =
    editBriefSource === undefined
      ? placeholderEditBrief(project, revision, artifacts.current === true)
      : migrationEditBrief(editBriefSource, project, revision, "frozen-legacy");
  const visual = snapshot.visual_composition
    ? sanitizedVisual(
        snapshot.visual_composition,
        project.project_id,
        timeline.timeline_id,
        revision,
        timeline.duration_us,
        transcript,
      )
    : undefined;
  return {
    schema_version: "creatorcut-local-snapshot/1.0",
    revision,
    project,
    timeline,
    transcript,
    edit_brief: editBrief,
    ...(visual ? { visual_composition: visual } : {}),
    ...(snapshot.restored_from_revision === undefined
      ? {}
      : {
          restored_from_revision: requiredInteger(
            snapshot.restored_from_revision,
            "legacy restored revision",
          ),
        }),
  };
}

const FINE_CUT_CARD_OPTIONS = [
  [
    "card_content_purpose",
    ["purpose_explain", "purpose_product", "purpose_conversion"],
  ],
  [
    "card_editing_density",
    ["density_clean", "density_balanced", "density_dynamic"],
  ],
  [
    "card_visual_language",
    [
      "visual_clean_premium",
      "visual_editorial_graphic",
      "visual_dynamic_marketing",
    ],
  ],
  ["card_motion_intensity", ["motion_none", "motion_subtle", "motion_dynamic"]],
  [
    "card_subject_treatment",
    ["subject_original", "subject_inset_mask", "subject_cutout_if_available"],
  ],
  [
    "card_caption_emphasis",
    ["emphasis_minimal", "emphasis_balanced", "emphasis_strong"],
  ],
  ["card_sfx_intensity", ["sfx_none", "sfx_light", "sfx_clear"]],
  ["card_cta_style", ["cta_none", "cta_subtle", "cta_card"]],
] as const;

async function sanitizedFineCutAudit(
  creatorcutDirectory: string,
  current: LocalProjectSnapshot,
  versions: ReadonlyMap<number, LocalProjectSnapshot>,
  sourceContents?: ReadonlyMap<string, Buffer>,
): Promise<{
  roughConfirmation: Record<string, unknown>;
  chain: Record<string, unknown>;
  candidate: LocalVisualComposition;
}> {
  const readSourceJson = async (relativePath: string): Promise<unknown> => {
    const contents = sourceContents?.get(relativePath);
    if (sourceContents) {
      if (!contents) {
        const error = new Error(`Missing migration source: ${relativePath}`);
        (error as NodeJS.ErrnoException).code = "ENOENT";
        throw error;
      }
      return JSON.parse(contents.toString("utf8")) as unknown;
    }
    return readJson(join(creatorcutDirectory, relativePath));
  };
  const rough = requiredRecord(
    await readSourceJson("rough-cut-confirmation.json"),
    "rough cut confirmation",
  );
  assertExactKeys(
    rough,
    [
      "schema_version",
      "confirmation_id",
      "project_id",
      "rough_cut_revision",
      "approved",
      "confirmed_at",
    ],
    "Rough cut confirmation",
  );
  const roughRevision = requiredInteger(
    rough.rough_cut_revision,
    "rough cut confirmation revision",
  );
  if (
    rough.schema_version !== "creatorcut-rough-cut-confirmation/1.0" ||
    rough.project_id !== current.project.project_id ||
    rough.approved !== true ||
    !versions.has(roughRevision)
  ) {
    throw new TypeError("Rough cut confirmation is invalid or stale");
  }
  const confirmationId = requiredString(
    rough.confirmation_id,
    "confirmation id",
  );
  assertIdentifier(confirmationId, "Rough cut confirmation ID");
  const confirmedAt = requiredString(rough.confirmed_at, "confirmation time");
  assertIsoDate(confirmedAt, "Rough cut confirmation time");

  const chainSource = requiredRecord(
    await readSourceJson("fine-cut-card-chain.json"),
    "fine cut chain",
  );
  assertAllowedKeys(
    chainSource,
    [
      "schema_version",
      "fine_cut_chain_id",
      "project_id",
      "rough_cut_revision",
      "step_count",
      "current_step_index",
      "state",
      "answers",
      "candidate_composition_id",
      "preview_relative_path",
      "preview_sha256",
      "preview_approval_token",
      "applied_revision",
      "created_at",
      "updated_at",
    ],
    [
      "schema_version",
      "fine_cut_chain_id",
      "project_id",
      "rough_cut_revision",
      "step_count",
      "current_step_index",
      "state",
      "answers",
      "previous_answer_digest",
      "candidate_composition_id",
      "preview_relative_path",
      "preview_sha256",
      "preview_approval_token",
      "applied_revision",
      "created_at",
      "updated_at",
    ],
    "Fine cut chain",
  );
  if (
    chainSource.schema_version !== "creatorcut-fine-cut-card-chain/1.0" ||
    chainSource.project_id !== current.project.project_id ||
    chainSource.rough_cut_revision !== roughRevision ||
    chainSource.step_count !== 8 ||
    chainSource.current_step_index !== 9 ||
    chainSource.state !== "applied" ||
    !Array.isArray(chainSource.answers) ||
    chainSource.answers.length !== 8
  ) {
    throw new TypeError("Fine cut chain is invalid or incomplete");
  }
  const chainId = requiredString(
    chainSource.fine_cut_chain_id,
    "fine cut chain id",
  );
  assertIdentifier(chainId, "Fine cut chain ID");
  const answers = chainSource.answers.map((rawAnswer, index) => {
    const answer = requiredRecord(rawAnswer, `fine cut answer ${index}`);
    assertExactKeys(
      answer,
      [
        "step_index",
        "card_id",
        "option_id",
        "presentation_digest",
        "answer_digest",
        "answered_at",
      ],
      `Fine cut answer ${index}`,
    );
    const expected = FINE_CUT_CARD_OPTIONS[index]!;
    if (
      answer.step_index !== index + 1 ||
      answer.card_id !== expected[0] ||
      !expected[1].includes(answer.option_id as never)
    ) {
      throw new TypeError("Fine cut answer sequence or option is invalid");
    }
    const presentationDigest = requiredString(
      answer.presentation_digest,
      "fine cut presentation digest",
    );
    const answerDigest = requiredString(
      answer.answer_digest,
      "fine cut answer digest",
    );
    assertDigest(presentationDigest, "Fine cut presentation digest");
    assertDigest(answerDigest, "Fine cut answer digest");
    const answeredAt = requiredString(
      answer.answered_at,
      "fine cut answer time",
    );
    assertIsoDate(answeredAt, "Fine cut answer time");
    return {
      step_index: index + 1,
      card_id: expected[0],
      option_id: answer.option_id,
      presentation_digest: presentationDigest,
      answer_digest: answerDigest,
      answered_at: answeredAt,
    };
  });
  const finalAnswerDigest = answers.at(-1)!.answer_digest;
  const previousAnswerDigest = requiredString(
    chainSource.previous_answer_digest,
    "fine cut previous answer digest",
  );
  assertDigest(previousAnswerDigest, "Fine cut previous answer digest");
  if (previousAnswerDigest !== finalAnswerDigest) {
    throw new TypeError("Fine cut chain answer digest binding is invalid");
  }
  const appliedRevision = requiredInteger(
    chainSource.applied_revision,
    "fine cut applied revision",
  );
  if (!versions.has(appliedRevision)) {
    throw new TypeError("Fine cut applied revision is missing");
  }
  const candidateId = requiredString(
    chainSource.candidate_composition_id,
    "fine cut candidate composition id",
  );
  assertIdentifier(candidateId, "Fine cut candidate composition ID");
  const previewRelativePath = requiredString(
    chainSource.preview_relative_path,
    "fine cut preview path",
  );
  safeRelativePath(previewRelativePath);
  if (!previewRelativePath.startsWith("previews/")) {
    throw new TypeError(
      "Fine cut preview must use the local preview namespace",
    );
  }
  const previewSha256 = requiredString(
    chainSource.preview_sha256,
    "preview digest",
  );
  assertDigest(previewSha256, "Fine cut preview digest");
  const previewBytes = await readLocalEvidenceBuffer(
    dirname(creatorcutDirectory),
    previewRelativePath,
  );
  if (digest(previewBytes) !== previewSha256) {
    throw new TypeError(
      "Fine cut preview digest does not match local evidence",
    );
  }
  const previewToken = requiredString(
    chainSource.preview_approval_token,
    "preview approval token",
  );
  assertIdentifier(previewToken, "Preview approval token");
  const roughSnapshot = versions.get(roughRevision)!;
  const candidate = sanitizedVisual(
    await readSourceJson("visual-composition-candidate.json"),
    current.project.project_id,
    roughSnapshot.timeline.timeline_id,
    roughRevision,
    roughSnapshot.timeline.duration_us,
    roughSnapshot.transcript,
    ["candidate"],
  );
  if (
    candidate.composition_id !== candidateId ||
    candidate.provenance.fine_cut_chain_id !== chainId ||
    candidate.provenance.answer_digest !== finalAnswerDigest ||
    previewToken !== `visual_${digestJcs(candidate).slice(7, 19)}`
  ) {
    throw new TypeError(
      "Fine cut preview approval is not bound to its candidate",
    );
  }
  const createdAt = requiredString(
    chainSource.created_at,
    "fine cut created_at",
  );
  const updatedAt = requiredString(
    chainSource.updated_at,
    "fine cut updated_at",
  );
  assertIsoDate(createdAt, "Fine cut created_at");
  assertIsoDate(updatedAt, "Fine cut updated_at");
  return {
    roughConfirmation: {
      schema_version: "creatorcut-rough-cut-confirmation/1.0",
      confirmation_id: confirmationId,
      project_id: current.project.project_id,
      rough_cut_revision: roughRevision,
      approved: true,
      confirmed_at: confirmedAt,
    },
    chain: {
      schema_version: "creatorcut-fine-cut-card-chain/1.0",
      fine_cut_chain_id: chainId,
      project_id: current.project.project_id,
      rough_cut_revision: roughRevision,
      step_count: 8,
      current_step_index: 9,
      state: "applied",
      answers,
      previous_answer_digest: previousAnswerDigest,
      candidate_composition_id: candidateId,
      preview_relative_path: previewRelativePath,
      preview_sha256: previewSha256,
      preview_approval_token: previewToken,
      applied_revision: appliedRevision,
      created_at: createdAt,
      updated_at: updatedAt,
    },
    candidate,
  };
}

async function prepareStage(
  creatorcutDirectory: string,
  backupDirectory: string,
  pending: PendingAuthorityMigration,
  stageDirectory: SafeCleanupDirectory,
): Promise<void> {
  const canonical = join(stageDirectory, "canonical");
  const rollbackSource = join(stageDirectory, "rollback-source");
  if (await pathExists(join(stageDirectory, "stage-complete.json"))) {
    try {
      await verifyStage(pending, stageDirectory);
      return;
    } catch {
      await removeSafeDirectory(stageDirectory);
    }
  }
  await removeSafeDirectory(stageDirectory);
  const backup = await readVerifiedBackupSnapshot(
    creatorcutDirectory,
    backupDirectory,
  );
  if (
    digest(JSON.stringify(backup.manifest)) !==
      pending.backup_manifest_digest ||
    entriesDigest(backup.manifest.files) !== pending.source_manifest_digest
  ) {
    throw new Error("Migration source backup binding changed before staging");
  }
  await durableMkdir(join(canonical, "versions"));
  await durableMkdir(join(rollbackSource, "metadata"));
  for (const file of backup.manifest.files) {
    const contents = backup.contents.get(file.relative_path);
    if (!contents) {
      throw new Error(
        `Verified rollback source is missing: ${file.relative_path}`,
      );
    }
    await atomicPrivateBuffer(
      join(rollbackSource, "metadata", file.relative_path),
      contents,
    );
  }
  await atomicPrivateJson(
    join(rollbackSource, "manifest.json"),
    backup.manifest,
  );
  await syncDirectoryTree(rollbackSource);
  const sourceJson = (relativePath: string): unknown | undefined => {
    const contents = backup.contents.get(relativePath);
    return contents
      ? (JSON.parse(contents.toString("utf8")) as unknown)
      : undefined;
  };
  const legacyHead = requireLegacyHead(
    sourceJson(LEGACY_HEAD_FILE) as LegacyHead,
  );
  const transcriptArtifact = sourceJson("transcript.json");
  const editBriefArtifact = sourceJson("edit-brief.json");
  const transcriptArtifactRevision =
    transcriptArtifact === undefined
      ? undefined
      : requiredInteger(
          requiredRecord(transcriptArtifact, "legacy transcript artifact")
            .revision,
          "legacy transcript artifact revision",
        );
  const editBriefArtifactRevision =
    editBriefArtifact === undefined
      ? undefined
      : requiredInteger(
          requiredRecord(editBriefArtifact, "legacy edit brief artifact")
            .base_revision,
          "legacy edit brief artifact revision",
        );
  const versionNames = backup.manifest.files
    .map((file) => file.relative_path)
    .filter((name) => /^versions\/\d+\.json$/u.test(name))
    .map((name) => name.slice("versions/".length))
    .sort(
      (left, right) => Number(left.slice(0, -5)) - Number(right.slice(0, -5)),
    );
  if (versionNames.length === 0) {
    throw new Error("Legacy CreatorCut project has no revision snapshots");
  }
  const revisionSet = new Set(
    versionNames.map((name) => Number(name.slice(0, -5))),
  );
  if (
    !revisionSet.has(legacyHead.history.current_revision) ||
    [...legacyHead.history.undo_stack, ...legacyHead.history.redo_stack].some(
      (revision) =>
        !Number.isSafeInteger(revision) || !revisionSet.has(revision),
    ) ||
    new Set([
      ...legacyHead.history.undo_stack,
      ...legacyHead.history.redo_stack,
    ]).size !==
      legacyHead.history.undo_stack.length +
        legacyHead.history.redo_stack.length
  ) {
    throw new TypeError("Legacy CreatorCut history targets are invalid");
  }
  const publicVersions = new Map<number, LocalProjectSnapshot>();
  for (const name of versionNames) {
    const revision = Number(name.slice(0, -5));
    const legacy = sourceJson(`versions/${name}`) as LegacySnapshot;
    const converted = publicSnapshot(legacy, revision, {
      ...(transcriptArtifactRevision !== undefined &&
      transcriptArtifactRevision <= revision
        ? { transcript: transcriptArtifact }
        : {}),
      ...(editBriefArtifactRevision !== undefined &&
      editBriefArtifactRevision <= revision
        ? { editBrief: editBriefArtifact }
        : {}),
      current: revision === legacyHead.history.current_revision,
    });
    publicVersions.set(revision, converted);
    await atomicPrivateJson(join(canonical, "versions", name), converted);
  }
  const current = publicSnapshot(
    legacyHead.snapshot,
    legacyHead.history.current_revision,
    {
      ...(transcriptArtifact === undefined
        ? {}
        : { transcript: transcriptArtifact }),
      ...(editBriefArtifact === undefined
        ? {}
        : { editBrief: editBriefArtifact }),
      current: true,
    },
  );
  if (
    digestJcs(current) !==
    digestJcs(publicVersions.get(legacyHead.history.current_revision))
  ) {
    throw new TypeError(
      "Legacy CreatorCut head does not match current version",
    );
  }
  const history: LocalRevisionHistory = {
    schema_version: "creatorcut-local-history/1.0",
    current_revision: legacyHead.history.current_revision,
    undo_stack: [...legacyHead.history.undo_stack],
    redo_stack: [...legacyHead.history.redo_stack],
  };
  const operationContents = backup.contents
    .get("operations.jsonl")!
    .toString("utf8");
  const legacyOperations = parseJsonLines<LegacyOperationRecord>(
    operationContents,
    "Legacy CreatorCut operation log",
  );
  const operations = legacyOperations.map(
    (record, index): LocalOperationLogEntry => {
      if (
        !["commit", "undo", "redo"].includes(record.kind) ||
        record.base_revision !== index ||
        record.resulting_revision !== index + 1 ||
        !revisionSet.has(record.base_revision) ||
        !revisionSet.has(record.resulting_revision) ||
        Number.isNaN(Date.parse(record.committed_at))
      ) {
        throw new TypeError(
          "Legacy CreatorCut operation chronology is invalid",
        );
      }
      if (
        (record.kind === "undo" || record.kind === "redo") &&
        (!Number.isSafeInteger(record.restored_from_revision) ||
          !revisionSet.has(record.restored_from_revision!))
      ) {
        throw new TypeError("Legacy CreatorCut restore target is invalid");
      }
      const operationIds =
        record.operations
          ?.map((operation) => operation.operation_id)
          .filter((value): value is string => typeof value === "string") ?? [];
      const restored = record.restored_from_revision;
      return {
        schema_version: "creatorcut-local-operation-log/1.0",
        revision: record.resulting_revision,
        base_revision: record.base_revision,
        kind: record.kind,
        operation_ids:
          operationIds.length > 0
            ? operationIds
            : [`local:${record.kind}:${restored ?? record.base_revision}`],
        ...(restored === undefined ? {} : { restored_from_revision: restored }),
        committed_at: new Date(record.committed_at).toISOString(),
      };
    },
  );
  if (
    operations.length !== pending.revision ||
    (pending.revision > 0 && operations.at(-1)?.revision !== pending.revision)
  ) {
    throw new TypeError("Legacy CreatorCut operation log is incomplete");
  }
  const currentVisual = current.visual_composition;
  const fineCutEvidencePaths = [
    "rough-cut-confirmation.json",
    "fine-cut-card-chain.json",
    "visual-composition-candidate.json",
  ];
  const fineCutEvidenceCount = fineCutEvidencePaths.filter((relativePath) =>
    backup.contents.has(relativePath),
  ).length;
  if (
    fineCutEvidenceCount !== 0 &&
    fineCutEvidenceCount !== fineCutEvidencePaths.length
  ) {
    throw new TypeError("Fine cut audit evidence is incomplete");
  }
  const fineCutAudit =
    fineCutEvidenceCount === fineCutEvidencePaths.length
      ? await sanitizedFineCutAudit(
          creatorcutDirectory,
          current,
          publicVersions,
          backup.contents,
        )
      : undefined;
  if (fineCutAudit) {
    const appliedRevision = requiredInteger(
      fineCutAudit.chain.applied_revision,
      "fine cut applied revision",
    );
    const appliedVisual =
      publicVersions.get(appliedRevision)?.visual_composition;
    const candidateMatches = (visual: LocalVisualComposition | undefined) =>
      visual?.composition_id === fineCutAudit.candidate.composition_id &&
      visual.provenance.fine_cut_chain_id ===
        fineCutAudit.candidate.provenance.fine_cut_chain_id &&
      digestJcs(visual.visual_events) ===
        digestJcs(fineCutAudit.candidate.visual_events);
    if (
      !appliedVisual ||
      !candidateMatches(appliedVisual) ||
      (currentVisual
        ? !candidateMatches(currentVisual)
        : !candidateMatches(
            publicVersions.get(history.redo_stack.at(-1) ?? -1)
              ?.visual_composition,
          ))
    ) {
      throw new TypeError(
        "Fine cut audit does not match applied visual history",
      );
    }
  }
  await Promise.all([
    atomicPrivateJson(join(canonical, "project.json"), current.project),
    atomicPrivateJson(join(canonical, "timeline.json"), current.timeline),
    atomicPrivateJson(join(canonical, "transcript.json"), current.transcript),
    atomicPrivateJson(join(canonical, "edit-brief.json"), current.edit_brief),
    atomicPrivateJson(join(canonical, "history.json"), history),
    atomicPrivateText(
      join(canonical, "operations.jsonl"),
      operations.map((record) => JSON.stringify(record)).join("\n") +
        (operations.length > 0 ? "\n" : ""),
    ),
    current.visual_composition
      ? atomicPrivateJson(
          join(canonical, "visual-composition.json"),
          current.visual_composition,
        )
      : Promise.resolve(),
    fineCutAudit
      ? atomicPrivateJson(
          join(canonical, "rough-cut-confirmation.json"),
          fineCutAudit.roughConfirmation,
        )
      : Promise.resolve(),
    fineCutAudit
      ? atomicPrivateJson(
          join(canonical, "fine-cut-card-chain.json"),
          fineCutAudit.chain,
        )
      : Promise.resolve(),
    fineCutAudit
      ? atomicPrivateJson(
          join(canonical, "visual-composition-candidate.json"),
          fineCutAudit.candidate,
        )
      : Promise.resolve(),
  ]);
  const files = await metadataEntries(canonical, "state");
  const stageManifest: AuthorityStageManifest = {
    schema_version: "creatorcut-authority-stage/1.1",
    migration_id: pending.migration_id,
    project_id: pending.project_id,
    revision: pending.revision,
    source_files_digest: entriesDigest(backup.manifest.files),
    files_digest: entriesDigest(files),
    files,
  };
  await atomicPrivateJson(
    join(stageDirectory, "stage-complete.json"),
    stageManifest,
  );
}

async function verifyStage(
  pending: PendingAuthorityMigration,
  stageDirectory: SafeCleanupDirectory,
): Promise<VerifiedAuthorityStage> {
  await assertAuthorityStagingInventory(
    dirname(dirname(stageDirectory)),
    pending.migration_id,
  );
  const stageEntries = await readdir(stageDirectory, { withFileTypes: true });
  const stageShape = stageEntries
    .map(
      (entry) =>
        `${entry.name}:${entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"}`,
    )
    .sort();
  if (
    stageShape.length !== 3 ||
    stageShape[0] !== "canonical:directory" ||
    stageShape[1] !== "rollback-source:directory" ||
    stageShape[2] !== "stage-complete.json:file"
  ) {
    throw new Error("Authority stage contains unbound entries");
  }
  const value = await readJson<unknown>(
    join(stageDirectory, "stage-complete.json"),
  );
  if (!isRecord(value))
    throw new TypeError("Authority stage manifest is invalid");
  assertExactKeys(
    value,
    [
      "schema_version",
      "migration_id",
      "project_id",
      "revision",
      "source_files_digest",
      "files_digest",
      "files",
    ],
    "Authority stage manifest",
  );
  if (
    value.schema_version !== "creatorcut-authority-stage/1.1" ||
    value.migration_id !== pending.migration_id ||
    value.project_id !== pending.project_id ||
    value.revision !== pending.revision ||
    !Array.isArray(value.files)
  ) {
    throw new TypeError("Authority stage manifest binding is invalid");
  }
  assertDigest(value.files_digest, "Authority stage files digest");
  assertDigest(
    value.source_files_digest,
    "Authority stage rollback source digest",
  );
  const manifest = value as unknown as AuthorityStageManifest;
  const actual = await readMetadataSnapshot(
    join(stageDirectory, "canonical"),
    "state",
  );
  if (
    !equalEntries(actual.files, manifest.files) ||
    entriesDigest(actual.files) !== manifest.files_digest
  ) {
    throw new Error("Authority staged canonical metadata digest mismatch");
  }
  const rollback = await readVerifiedBackupSnapshotAtRoot(
    join(stageDirectory, "rollback-source"),
  );
  if (
    rollback.manifest.project_id !== pending.project_id ||
    rollback.manifest.project_revision !== pending.revision ||
    digest(JSON.stringify(rollback.manifest)) !==
      pending.backup_manifest_digest ||
    entriesDigest(rollback.manifest.files) !== pending.source_manifest_digest ||
    manifest.source_files_digest !== pending.source_manifest_digest
  ) {
    throw new Error("Authority staged rollback source digest mismatch");
  }
  const canonical = await validateCanonicalPublicStateUnlocked(
    join(stageDirectory, "canonical"),
    { migratedThroughRevision: pending.revision },
  );
  if (
    canonical.projectId !== pending.project_id ||
    canonical.revision !== pending.revision
  ) {
    throw new TypeError(
      "Authority staged canonical project binding is invalid",
    );
  }
  await assertAuthorityStagingInventory(
    dirname(dirname(stageDirectory)),
    pending.migration_id,
  );
  return { ...manifest, contents: actual.contents, rollback };
}

function inject(
  actual: AuthorityMigrationFailureStage | undefined,
  expected: AuthorityMigrationFailureStage,
): void {
  if (actual === expected) throw new Error(`Injected failure: ${expected}`);
}

async function copyCanonicalFile(
  verified: VerifiedAuthorityStage,
  creatorcutDirectory: string,
  name: string,
): Promise<void> {
  const contents = verified.contents.get(name);
  if (!contents) {
    throw new Error(`Authority staged canonical file is missing: ${name}`);
  }
  await atomicPrivateBuffer(join(creatorcutDirectory, name), contents);
}

async function installPublicCanonical(
  creatorcutDirectory: string,
  backupDirectory: string,
  pending: PendingAuthorityMigration,
  stageDirectory: SafeCleanupDirectory,
  failureStage?: AuthorityMigrationFailureStage,
): Promise<StorageAuthorityMarker> {
  const verified = await verifyStage(pending, stageDirectory);
  if (
    pending.stage_files_digest === null ||
    verified.files_digest !== pending.stage_files_digest
  ) {
    throw new Error(
      "Pending migration stage digest changed inside installation",
    );
  }
  const rollbackSnapshot = verified.rollback;
  assertPendingBackupBinding(
    rollbackSnapshot,
    pending,
    "Migration backup binding changed before destructive installation",
  );
  let markerPublished = false;
  try {
    const versions = safeProjectDirectory(creatorcutDirectory, "versions");
    await removeSafeDirectory(versions);
    await durableMkdir(versions);
    for (const file of verified.files.filter((candidate) =>
      candidate.relative_path.startsWith("versions/"),
    )) {
      await copyCanonicalFile(
        verified,
        creatorcutDirectory,
        file.relative_path,
      );
    }
    inject(failureStage, "after_versions_replace");
    for (const name of [
      "project.json",
      "timeline.json",
      "transcript.json",
      "edit-brief.json",
      "history.json",
      "operations.jsonl",
    ]) {
      await copyCanonicalFile(verified, creatorcutDirectory, name);
    }
    if (verified.contents.has("visual-composition.json")) {
      await copyCanonicalFile(
        verified,
        creatorcutDirectory,
        "visual-composition.json",
      );
    } else {
      await rm(join(creatorcutDirectory, "visual-composition.json"), {
        force: true,
      });
    }
    for (const name of [
      "rough-cut-confirmation.json",
      "fine-cut-card-chain.json",
      "visual-composition-candidate.json",
    ]) {
      if (verified.contents.has(name)) {
        await copyCanonicalFile(verified, creatorcutDirectory, name);
      } else {
        await durableRemove(join(creatorcutDirectory, name));
      }
    }
    const installed = await validateCanonicalPublicStateUnlocked(
      creatorcutDirectory,
      { migratedThroughRevision: pending.revision },
    );
    if (
      installed.projectId !== pending.project_id ||
      installed.revision !== pending.revision
    ) {
      throw new TypeError("Installed canonical project binding is invalid");
    }
    assertPendingBackupBinding(
      await readVerifiedBackupSnapshot(creatorcutDirectory, backupDirectory),
      pending,
      "Migration backup binding changed before legacy artifact removal",
    );
    const runtimeArtifactRemovals = [
      ["director-consent.json", "after_legacy_director_consent_remove"],
      ["director-state.json", "after_legacy_director_state_remove"],
      ["preview-confirmation.json", "after_legacy_preview_confirmation_remove"],
    ] as const satisfies ReadonlyArray<
      readonly [string, AuthorityMigrationFailureStage]
    >;
    for (const [name, afterRemoval] of runtimeArtifactRemovals) {
      await durableRemove(join(creatorcutDirectory, name));
      inject(failureStage, afterRemoval);
    }
    const installedSnapshot = await readMetadataSnapshot(
      creatorcutDirectory,
      "state",
    );
    if (
      !equalEntries(installedSnapshot.files, verified.files) ||
      entriesDigest(installedSnapshot.files) !== pending.stage_files_digest
    ) {
      throw new Error(
        "Installed canonical metadata does not match the bound migration stage",
      );
    }
    inject(failureStage, "after_mirrors_replace");
    assertPendingBackupBinding(
      await readVerifiedBackupSnapshot(creatorcutDirectory, backupDirectory),
      pending,
      "Migration backup binding changed before legacy metadata removal",
    );
    const legacyRemovals = [
      [LEGACY_HEAD_FILE, "after_legacy_head_remove"],
      ["m1-1-dogfood-report.json", "after_legacy_report_remove"],
      ["import-source.json", "after_legacy_import_remove"],
      ["studio.json", "after_legacy_studio_remove"],
    ] as const satisfies ReadonlyArray<
      readonly [string, AuthorityMigrationFailureStage]
    >;
    for (const [legacyName, afterRemoval] of legacyRemovals) {
      await durableRemove(join(creatorcutDirectory, legacyName));
      inject(failureStage, afterRemoval);
    }
    await assertAuthorityStagingInventory(
      creatorcutDirectory,
      pending.migration_id,
    );
    assertPendingBackupBinding(
      await readVerifiedBackupSnapshot(creatorcutDirectory, backupDirectory),
      pending,
      "Migration backup binding changed before authority publication",
    );
    const marker = await writeInitialMarker(creatorcutDirectory, {
      projectId: pending.project_id,
      revision: pending.revision,
      generation: 1,
      migrationId: pending.migration_id,
      sourceFormat: "creatorcut-internal-project-store/1.0-alpha",
      backupManifestDigest: pending.backup_manifest_digest,
      handoffSourceFilesDigest: pending.source_manifest_digest,
      handoffStageFilesDigest: pending.stage_files_digest,
      initialMutationKind: "authority_handoff",
      now: new Date(),
      ...(failureStage ? { failureStage } : {}),
    });
    markerPublished = true;
    inject(failureStage, "after_authority_marker");
    if (failureStage === "after_initial_pending_remove_before_stage_cleanup") {
      await durableRemove(join(creatorcutDirectory, PENDING_FILE));
      inject(failureStage, "after_initial_pending_remove_before_stage_cleanup");
    }
    await removeVerifiedCommittedAuthorityStage(creatorcutDirectory, marker);
    await durableRemove(join(creatorcutDirectory, PENDING_FILE));
    return marker;
  } catch (error) {
    const injectedFailure =
      error instanceof Error && error.message.startsWith("Injected failure:");
    const backupBindingFailure =
      error instanceof Error &&
      /backup (?:binding|changed)/iu.test(error.message);
    if (!markerPublished && !injectedFailure && backupBindingFailure) {
      try {
        await restoreBackupMetadata(
          creatorcutDirectory,
          backupDirectory,
          rollbackSnapshot,
          stageDirectory,
        );
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Authority installation failed and exact backup restoration also failed: ${restoreError instanceof Error ? restoreError.message : "unknown restore error"}`,
        );
      }
    }
    throw error;
  }
}

async function assertSourceMatchesPendingBackup(
  creatorcutDirectory: string,
  manifest: MetadataBackupManifest,
  pending: PendingAuthorityMigration,
): Promise<void> {
  if (entriesDigest(manifest.files) !== pending.source_manifest_digest) {
    throw new Error("Pending migration source manifest binding changed");
  }
  const current = await metadataEntries(creatorcutDirectory, "backup");
  if (
    !equalEntries(current, manifest.files) ||
    entriesDigest(current) !== pending.source_manifest_digest
  ) {
    throw new Error("Source metadata changed after migration became pending");
  }
}

async function assertRecoverablePartialInstall(
  creatorcutDirectory: string,
  backupManifest: MetadataBackupManifest,
  stageDirectory: SafeCleanupDirectory,
  stageManifest: AuthorityStageManifest,
  pending: PendingAuthorityMigration,
): Promise<void> {
  const backupByPath = new Map(
    backupManifest.files.map((file) => [file.relative_path, file]),
  );
  const stageByPath = new Map(
    stageManifest.files.map((file) => [file.relative_path, file]),
  );
  const current = await readMetadataSnapshot(creatorcutDirectory, "backup");
  const head = backupByPath.get(LEGACY_HEAD_FILE);
  const currentHead = current.files.find(
    (file) => file.relative_path === LEGACY_HEAD_FILE,
  );
  if (!head || (currentHead && !equalEntries([head], [currentHead]))) {
    throw new Error(
      "Partial migration no longer contains the exact internal head",
    );
  }
  for (const file of current.files) {
    const backupFile = backupByPath.get(file.relative_path);
    const stageFile = stageByPath.get(file.relative_path);
    const matchesBoundSnapshot = [backupFile, stageFile].some(
      (candidate) =>
        candidate?.sha256 === file.sha256 &&
        candidate.size_bytes === file.size_bytes,
    );
    if (matchesBoundSnapshot) continue;
    if (file.relative_path === MUTATION_JOURNAL_FILE) {
      const journal = current.contents.get(MUTATION_JOURNAL_FILE);
      const entries = journal
        ? parseJsonLines<unknown>(
            journal.toString("utf8"),
            "CreatorCut initial handoff journal",
          ).map(assertStorageMutationJournalEntry)
        : [];
      const [entry] = entries;
      if (
        entries.length === 1 &&
        entry?.generation === 1 &&
        entry.migration_id === pending.migration_id &&
        entry.project_id === pending.project_id &&
        entry.mutation_kind === "authority_handoff" &&
        entry.project_revision === pending.revision &&
        entry.canonical_state_digest ===
          (await managedMetadataDigest(creatorcutDirectory))
      ) {
        continue;
      }
    }
    throw new Error(
      `Partial migration contains unbound metadata bytes: ${file.relative_path}`,
    );
  }
}

export async function migrateLegacyInternalProject(
  projectDirectory: string,
  input: MigrateLegacyInternalProjectInput,
): Promise<StorageAuthorityMigrationResult> {
  const creatorcutDirectory = join(resolve(projectDirectory), ".creatorcut");
  const backupDirectory = await validateBackupRoot(
    creatorcutDirectory,
    input.backupDirectory,
  );
  return withCreatorCutProjectLock(creatorcutDirectory, async () => {
    await recoverPublicMutationUnlocked(creatorcutDirectory);
    await removeEmptyPublicMutationWalUnlocked(creatorcutDirectory);
    const pendingPath = join(creatorcutDirectory, PENDING_FILE);
    const authorityPath = join(creatorcutDirectory, AUTHORITY_FILE);
    const existingPending = (await pathExists(pendingPath))
      ? assertPending(await readJson(pendingPath))
      : null;
    const existingAuthority = (await pathExists(authorityPath))
      ? await readJson<Record<string, unknown>>(authorityPath)
      : null;
    const existingPublicMarker =
      existingAuthority?.authority === "public-runtime"
        ? assertMarker(existingAuthority)
        : null;
    await assertAuthorityStagingInventory(
      creatorcutDirectory,
      existingPending?.migration_id ??
        existingPublicMarker?.migration_id ??
        null,
    );
    if (existingPublicMarker) {
      const marker = existingPublicMarker;
      if (existingPending) {
        if (
          existingPending.direction !== "to_public" ||
          existingPending.phase !== "installing" ||
          existingPending.migration_id !== marker.migration_id
        ) {
          throw new Error("Authority marker and pending migration disagree");
        }
      }
      await validateMarkerBindingUnlocked(creatorcutDirectory, marker);
      if (input.migrationId && input.migrationId !== marker.migration_id) {
        throw new Error("Project was migrated with another migration ID");
      }
      const manifest = await verifyBackup(creatorcutDirectory, backupDirectory);
      if (digest(JSON.stringify(manifest)) !== marker.backup_manifest_digest) {
        throw new Error("Migrated project requires its exact backup");
      }
      if (
        existingPending &&
        entriesDigest(manifest.files) !== existingPending.source_manifest_digest
      ) {
        throw new Error("Migrated project pending source binding changed");
      }
      if (existingPending) {
        for (const legacyName of [
          LEGACY_HEAD_FILE,
          "m1-1-dogfood-report.json",
          "import-source.json",
          "studio.json",
          ...NON_TRANSFERRED_RUNTIME_ARTIFACTS,
        ]) {
          await durableRemove(join(creatorcutDirectory, legacyName));
        }
        if (
          input.failureStage ===
          "after_recovery_pending_remove_before_stage_cleanup"
        ) {
          await durableRemove(pendingPath);
          inject(
            input.failureStage,
            "after_recovery_pending_remove_before_stage_cleanup",
          );
        }
      }
      await removeVerifiedCommittedAuthorityStage(creatorcutDirectory, marker);
      if (existingPending) {
        await durableRemove(pendingPath);
      }
      return {
        status: "already_migrated",
        project_id: marker.project_id,
        revision: marker.current_revision,
        migration_id: marker.migration_id,
        authority: "public-runtime",
        backup_directory: backupDirectory,
        recovered: existingPending !== null,
      };
    }
    if (
      existingAuthority &&
      (existingAuthority.schema_version !==
        "creatorcut-storage-authority/1.0" ||
        existingAuthority.authority !== "internal-project-store")
    ) {
      throw new Error("Unsupported CreatorCut storage authority marker");
    }
    let pending = existingPending;
    let backupManifest: MetadataBackupManifest;
    const recovered = pending !== null;
    if (pending) {
      if (pending.direction !== "to_public") {
        throw new Error("A storage authority rollback is pending");
      }
      if (pending.phase === "installing") {
        const recoveryStage = await safeStageDirectory(
          creatorcutDirectory,
          pending.migration_id,
        );
        backupManifest = (await verifyStage(pending, recoveryStage)).rollback
          .manifest;
      } else {
        const manifest = await verifyBackup(
          creatorcutDirectory,
          backupDirectory,
        );
        if (
          digest(JSON.stringify(manifest)) !== pending.backup_manifest_digest
        ) {
          throw new Error("Pending migration backup manifest changed");
        }
        if (entriesDigest(manifest.files) !== pending.source_manifest_digest) {
          throw new Error("Pending migration source manifest changed");
        }
        backupManifest = manifest;
      }
    } else {
      const head = requireLegacyHead(
        await readJson<LegacyHead>(join(creatorcutDirectory, LEGACY_HEAD_FILE)),
      );
      const projectId = head.snapshot.project.project_id;
      const revision = head.snapshot.project.revision;
      const backup = await createOrVerifyBackup(
        creatorcutDirectory,
        backupDirectory,
        projectId,
        revision,
      );
      const migrationId =
        input.migrationId ??
        `handoff_${digest(JSON.stringify(head)).slice(7, 19)}`;
      assertIdentifier(migrationId, "Migration ID");
      pending = {
        schema_version: "creatorcut-authority-migration/1.1",
        direction: "to_public",
        phase: "source_locked",
        migration_id: migrationId,
        project_id: projectId,
        revision,
        backup_manifest_digest: backup.manifestDigest,
        source_manifest_digest: entriesDigest(backup.sourceFiles),
        stage_files_digest: null,
        created_at: new Date().toISOString(),
      };
      backupManifest = backup.manifest;
      const beforePending = await metadataEntries(
        creatorcutDirectory,
        "backup",
      );
      if (!equalEntries(backup.sourceFiles, beforePending)) {
        throw new Error("Source metadata changed before migration was locked");
      }
      await atomicPrivateJson(pendingPath, pending);
      const afterPending = await metadataEntries(creatorcutDirectory, "backup");
      if (!equalEntries(backup.sourceFiles, afterPending)) {
        await durableRemove(pendingPath);
        throw new Error(
          "Source metadata changed while migration was being locked",
        );
      }
      inject(input.failureStage, "after_pending_write");
    }
    const stage = await safeStageDirectory(
      creatorcutDirectory,
      pending.migration_id,
    );
    if (pending.phase === "installing") {
      const stageManifest = await verifyStage(pending, stage);
      if (stageManifest.files_digest !== pending.stage_files_digest) {
        throw new Error("Pending migration stage digest changed");
      }
      await assertRecoverablePartialInstall(
        creatorcutDirectory,
        backupManifest,
        stage,
        stageManifest,
        pending,
      );
      const restoreSnapshot = stageManifest.rollback;
      assertPendingBackupBinding(
        restoreSnapshot,
        pending,
        "Migration recovery requires its exact pending backup",
      );
      await restoreBackupMetadata(
        creatorcutDirectory,
        backupDirectory,
        restoreSnapshot,
        stage,
      );
      pending = { ...pending, phase: "staged" };
      await atomicPrivateJson(pendingPath, pending);
    }
    if (pending.phase === "source_locked") {
      await assertSourceMatchesPendingBackup(
        creatorcutDirectory,
        backupManifest,
        pending,
      );
      await prepareStage(creatorcutDirectory, backupDirectory, pending, stage);
      const stageManifest = await verifyStage(pending, stage);
      pending = {
        ...pending,
        phase: "staged",
        stage_files_digest: stageManifest.files_digest,
      };
      await atomicPrivateJson(pendingPath, pending);
      inject(input.failureStage, "after_staging_write");
    }
    if (pending.phase !== "staged" || pending.stage_files_digest === null) {
      throw new Error("Pending migration is not ready for installation");
    }
    const stageManifest = await verifyStage(pending, stage);
    if (stageManifest.files_digest !== pending.stage_files_digest) {
      throw new Error("Pending migration stage digest changed");
    }
    const finalBackupManifest = await verifyBackup(
      creatorcutDirectory,
      backupDirectory,
    );
    if (
      digest(JSON.stringify(finalBackupManifest)) !==
        pending.backup_manifest_digest ||
      entriesDigest(finalBackupManifest.files) !==
        pending.source_manifest_digest
    ) {
      throw new Error("Migration backup changed before installation");
    }
    await assertSourceMatchesPendingBackup(
      creatorcutDirectory,
      finalBackupManifest,
      pending,
    );
    pending = { ...pending, phase: "installing" };
    await atomicPrivateJson(pendingPath, pending);
    const marker = await installPublicCanonical(
      creatorcutDirectory,
      backupDirectory,
      pending,
      stage,
      input.failureStage,
    );
    return {
      status: "migrated",
      project_id: marker.project_id,
      revision: marker.current_revision,
      migration_id: marker.migration_id,
      authority: "public-runtime",
      backup_directory: backupDirectory,
      recovered,
    };
  });
}

async function restoreBackupMetadata(
  creatorcutDirectory: string,
  backupDirectory: string,
  verifiedSnapshot?: VerifiedMetadataBackup,
  authorityStageDirectory?: SafeCleanupDirectory,
): Promise<void> {
  const restoreRoot = await realpath(creatorcutDirectory);
  const verified =
    verifiedSnapshot ??
    (await readVerifiedBackupSnapshot(creatorcutDirectory, backupDirectory));
  const manifest = verified.manifest;
  const stage =
    authorityStageDirectory ??
    (await safeStageDirectory(
      creatorcutDirectory,
      `restore_${digest(JSON.stringify(manifest)).slice(7, 23)}`,
    ));
  const prepared = resolve(stage, "restore-prepared") as SafeCleanupDirectory;
  const displaced = resolve(stage, "restore-displaced") as SafeCleanupDirectory;
  if (!containedChild(stage, prepared) || !containedChild(stage, displaced)) {
    throw new TypeError("Restore staging path is unsafe");
  }
  await removeSafeDirectory(prepared);
  await removeSafeDirectory(displaced);
  await durableMkdir(prepared);
  await durableMkdir(displaced);
  for (const file of manifest.files) {
    const contents = verified.contents.get(file.relative_path);
    if (!contents) {
      throw new Error(
        `Verified backup buffer is missing: ${file.relative_path}`,
      );
    }
    await atomicPrivateBuffer(join(prepared, file.relative_path), contents);
  }
  await syncDirectoryTree(prepared);

  const currentPaths = await collectMetadataFiles(restoreRoot, "backup");
  const rootNames = new Set(
    [...currentPaths, ...manifest.files.map((file) => file.relative_path)]
      .filter((relativePath) => !relativePath.includes("/"))
      .sort(),
  );
  const trustedRoot = await openTrustedDirectoryChain(restoreRoot, restoreRoot);
  try {
    await assertTrustedDirectoryChain(trustedRoot);
    const versionsPath = join(restoreRoot, "versions");
    if (await pathExists(versionsPath)) {
      await rename(versionsPath, join(displaced, "versions"));
      await syncDirectory(restoreRoot);
      await syncDirectory(displaced);
    }
    for (const name of rootNames) {
      const target = join(restoreRoot, name);
      if (!(await pathExists(target))) continue;
      await assertTrustedDirectoryChain(trustedRoot);
      await rename(target, join(displaced, name));
      await syncDirectory(restoreRoot);
      await syncDirectory(displaced);
    }
    await assertTrustedDirectoryChain(trustedRoot);
    const versionFiles = manifest.files.filter((file) =>
      file.relative_path.startsWith("versions/"),
    );
    if (versionFiles.length > 0) {
      await assertTrustedDirectoryChain(trustedRoot);
      if (await pathExists(versionsPath)) {
        throw new Error("Restore revision destination was replaced");
      }
      await rename(join(prepared, "versions"), versionsPath);
      await syncDirectory(prepared);
      await syncDirectory(restoreRoot);
      await assertTrustedDirectoryChain(trustedRoot);
    }
    for (const file of manifest.files.filter(
      (candidate) => !candidate.relative_path.includes("/"),
    )) {
      const contents = verified.contents.get(file.relative_path);
      if (!contents) {
        throw new Error(
          `Verified backup buffer is missing: ${file.relative_path}`,
        );
      }
      await writePrivateBufferNoReplace(
        join(restoreRoot, file.relative_path),
        contents,
        trustedRoot,
      );
    }
    await assertTrustedDirectoryChain(trustedRoot);
  } finally {
    await closeTrustedDirectoryChain(trustedRoot);
  }
  await removeSafeDirectory(prepared);
  await removeSafeDirectory(displaced);
}

export async function verifyMigratedVisualHandoff(
  projectDirectory: string,
): Promise<MigratedVisualHandoffVerification> {
  const creatorcutDirectory = join(resolve(projectDirectory), ".creatorcut");
  return withCreatorCutProjectLock(creatorcutDirectory, async () => {
    const marker =
      await validatePublicStorageAuthorityUnlocked(creatorcutDirectory);
    if (
      marker.source_format !== "creatorcut-internal-project-store/1.0-alpha"
    ) {
      throw new TypeError("Project is not an internal visual handoff");
    }
    const versions = new Map<number, LocalProjectSnapshot>();
    for (const name of await readdir(join(creatorcutDirectory, "versions"))) {
      if (!/^\d+\.json$/u.test(name)) continue;
      const revision = Number(name.slice(0, -5));
      versions.set(
        revision,
        await readJson<LocalProjectSnapshot>(
          join(creatorcutDirectory, "versions", name),
        ),
      );
    }
    const current = versions.get(marker.current_revision);
    if (!current)
      throw new TypeError("Migrated handoff current snapshot is missing");
    const history = await readJson<LocalRevisionHistory>(
      join(creatorcutDirectory, "history.json"),
    );
    const fineCutEvidencePaths = [
      "rough-cut-confirmation.json",
      "fine-cut-card-chain.json",
      "visual-composition-candidate.json",
    ];
    const fineCutEvidencePresence = await Promise.all(
      fineCutEvidencePaths.map((relativePath) =>
        pathExists(join(creatorcutDirectory, relativePath)),
      ),
    );
    const fineCutEvidenceCount = fineCutEvidencePresence.filter(Boolean).length;
    const historicalVisualPresent = [...versions.values()].some(
      (snapshot) => snapshot.visual_composition !== undefined,
    );
    if (fineCutEvidenceCount === 0 && !historicalVisualPresent) {
      return {
        schema_version: "creatorcut-handoff-verification/1.0",
        project_id: marker.project_id,
        current_revision: marker.current_revision,
        migration_id: marker.migration_id,
        visual_handoff_present: false,
        next: "public_workflow",
      };
    }
    if (
      fineCutEvidenceCount !== fineCutEvidencePaths.length ||
      !historicalVisualPresent
    ) {
      throw new TypeError("Migrated visual handoff evidence is incomplete");
    }
    const audit = await sanitizedFineCutAudit(
      creatorcutDirectory,
      current,
      versions,
    );
    const chain = audit.chain;
    const candidate = audit.candidate;
    const appliedRevision = requiredInteger(
      chain.applied_revision,
      "fine cut applied revision",
    );
    const currentVisual = current.visual_composition;
    const redoRevision = history.redo_stack.at(-1);
    const redoVisual =
      redoRevision === undefined
        ? undefined
        : versions.get(redoRevision)?.visual_composition;
    const sameCandidate = (visual: LocalVisualComposition | undefined) =>
      visual?.composition_id === candidate.composition_id &&
      visual.provenance.fine_cut_chain_id ===
        candidate.provenance.fine_cut_chain_id &&
      digestJcs(visual.visual_events) === digestJcs(candidate.visual_events);
    const operations = parseJsonLines<LocalOperationLogEntry>(
      await readFile(join(creatorcutDirectory, "operations.jsonl"), "utf8"),
      "CreatorCut operation log",
    );
    if (
      !operations.some(
        (operation) =>
          operation.revision === appliedRevision && operation.kind === "commit",
      ) ||
      !sameCandidate(versions.get(appliedRevision)?.visual_composition)
    ) {
      throw new TypeError(
        "Migrated handoff apply audit evidence is incomplete",
      );
    }
    if (
      currentVisual?.state === "active"
        ? !sameCandidate(currentVisual)
        : currentVisual?.state === "needs_rebase"
          ? currentVisual.composition_id !== candidate.composition_id
          : !sameCandidate(redoVisual)
    ) {
      throw new TypeError(
        "Migrated handoff current or redo visual binding is invalid",
      );
    }
    const approvalToken = requiredString(
      chain.preview_approval_token,
      "preview approval token",
    );
    return {
      schema_version: "creatorcut-handoff-verification/1.0",
      project_id: marker.project_id,
      current_revision: marker.current_revision,
      migration_id: marker.migration_id,
      visual_handoff_present: true,
      fine_cut_chain_id: requiredString(
        chain.fine_cut_chain_id,
        "fine cut chain id",
      ),
      candidate_composition_id: requiredString(
        candidate.composition_id,
        "candidate composition id",
      ),
      applied_revision: appliedRevision,
      preview_approval_present: true,
      preview_binding_valid: true,
      preview_token_digest: digest(approvalToken),
      preview_sha256: requiredString(chain.preview_sha256, "preview digest"),
      visual_state:
        currentVisual?.state === "active"
          ? "active"
          : currentVisual?.state === "needs_rebase"
            ? "needs_rebase"
            : "redo_available",
      ...(currentVisual
        ? { current_visual_composition_id: currentVisual.composition_id }
        : {}),
      ...(redoRevision === undefined ? {} : { redo_revision: redoRevision }),
      next:
        currentVisual?.state === "active"
          ? "export_plan"
          : currentVisual?.state === "needs_rebase"
            ? "handoff_repair"
            : "edit_redo",
    };
  });
}

export async function rollbackStorageAuthorityMigration(
  projectDirectory: string,
  backupDirectoryValue: string,
  failureStage?: AuthorityMigrationFailureStage,
): Promise<StorageAuthorityMigrationResult> {
  const creatorcutDirectory = join(resolve(projectDirectory), ".creatorcut");
  const backupDirectory = await validateBackupRoot(
    creatorcutDirectory,
    backupDirectoryValue,
  );
  return withCreatorCutProjectLock(creatorcutDirectory, async () => {
    await recoverPublicMutationUnlocked(creatorcutDirectory);
    await removeEmptyPublicMutationWalUnlocked(creatorcutDirectory);
    const pendingPath = join(creatorcutDirectory, PENDING_FILE);
    let pending = (await pathExists(pendingPath))
      ? assertPending(await readJson(pendingPath))
      : null;
    await assertAuthorityStagingInventory(
      creatorcutDirectory,
      pending?.migration_id ?? null,
    );
    let marker: StorageAuthorityMarker | null = null;
    if (pending?.direction === "to_public") {
      const rollbackStage = await safeStageDirectory(
        creatorcutDirectory,
        pending.migration_id,
      );
      const verified =
        pending.phase === "source_locked"
          ? await readVerifiedBackupSnapshot(
              creatorcutDirectory,
              backupDirectory,
            )
          : (await verifyStage(pending, rollbackStage)).rollback;
      assertPendingBackupBinding(
        verified,
        pending,
        "Pending migration rollback requires its exact backup",
      );
      const authorityPath = join(creatorcutDirectory, AUTHORITY_FILE);
      if (await pathExists(authorityPath)) {
        const authority =
          await readJson<Record<string, unknown>>(authorityPath);
        if (authority.authority === "public-runtime") {
          throw new Error(
            "Pending migration already published public authority; recover migration before rollback",
          );
        }
      }
      const restoreSnapshot = verified;
      assertPendingBackupBinding(
        restoreSnapshot,
        pending,
        "Pending migration rollback requires its exact backup",
      );
      await restoreBackupMetadata(
        creatorcutDirectory,
        backupDirectory,
        restoreSnapshot,
        rollbackStage,
      );
      inject(failureStage, "after_mirrors_replace");
      const restoredBackup = restoreSnapshot;
      assertPendingBackupBinding(
        restoredBackup,
        pending,
        "Pending migration rollback backup changed during restoration",
      );
      const restoredEntries = await metadataEntries(
        creatorcutDirectory,
        "backup",
      );
      if (!equalEntries(restoredEntries, restoredBackup.manifest.files)) {
        throw new Error(
          "Pending migration rollback did not restore exact backup bytes",
        );
      }
      await removeAuthorityStageAndEmptyRoot(
        creatorcutDirectory,
        pending.migration_id,
      );
      await durableRemove(pendingPath);
      return {
        status: "rolled_back",
        project_id: pending.project_id,
        revision: pending.revision,
        migration_id: pending.migration_id,
        authority: "internal-project-store",
        backup_directory: backupDirectory,
        recovered: true,
      };
    }
    const recovered = pending !== null;
    if (!pending) {
      if (await pathExists(join(creatorcutDirectory, AUTHORITY_FILE))) {
        marker = assertMarker(
          await readJson(join(creatorcutDirectory, AUTHORITY_FILE)),
        );
        await validateMarkerBindingUnlocked(creatorcutDirectory, marker);
      }
      if (!marker) throw new Error("No public authority migration is active");
      if (
        marker.source_format !==
          "creatorcut-internal-project-store/1.0-alpha" ||
        marker.generation !== marker.handoff_generation ||
        marker.current_revision !== marker.adopted_revision
      ) {
        throw new Error(
          "Authority rollback is disabled after a public mutation",
        );
      }
      const manifest = await verifyBackup(creatorcutDirectory, backupDirectory);
      if (
        manifest.project_id !== marker.project_id ||
        manifest.project_revision !== marker.adopted_revision ||
        digest(JSON.stringify(manifest)) !== marker.backup_manifest_digest
      ) {
        throw new Error(
          "Authority rollback requires the exact migration backup",
        );
      }
      pending = {
        schema_version: "creatorcut-authority-migration/1.1",
        direction: "rollback_to_internal",
        phase: "rollback_locked",
        migration_id: marker.migration_id,
        project_id: marker.project_id,
        revision: marker.adopted_revision,
        backup_manifest_digest: marker.backup_manifest_digest,
        source_manifest_digest: entriesDigest(manifest.files),
        stage_files_digest: null,
        created_at: new Date().toISOString(),
      };
      await atomicPrivateJson(pendingPath, pending);
      inject(failureStage, "after_pending_write");
    } else {
      const manifest = await verifyBackup(creatorcutDirectory, backupDirectory);
      if (
        digest(JSON.stringify(manifest)) !== pending.backup_manifest_digest ||
        entriesDigest(manifest.files) !== pending.source_manifest_digest
      ) {
        throw new Error("Pending rollback requires its exact backup");
      }
      const authorityPath = join(creatorcutDirectory, AUTHORITY_FILE);
      const backupAuthority = manifest.files.find(
        (file) => file.relative_path === AUTHORITY_FILE,
      );
      if (await pathExists(authorityPath)) {
        const raw = await readJson<Record<string, unknown>>(authorityPath);
        if (raw.authority === "public-runtime") {
          marker = assertMarker(raw);
          if (
            marker.migration_id !== pending.migration_id ||
            marker.project_id !== pending.project_id
          ) {
            throw new Error("Pending rollback public marker identity changed");
          }
        } else {
          if (!backupAuthority) {
            throw new Error(
              "Pending rollback restored an unexpected authority marker",
            );
          }
          const contents = await readFile(authorityPath);
          if (
            contents.byteLength !== backupAuthority.size_bytes ||
            digest(contents).slice(7) !== backupAuthority.sha256
          ) {
            throw new Error(
              "Pending rollback internal marker differs from backup",
            );
          }
        }
      } else if (backupAuthority) {
        throw new Error(
          "Pending rollback internal authority marker is missing",
        );
      }
    }
    const restoreSnapshot = await readVerifiedBackupSnapshot(
      creatorcutDirectory,
      backupDirectory,
    );
    assertPendingBackupBinding(
      restoreSnapshot,
      pending,
      "Pending rollback requires its exact backup",
    );
    await restoreBackupMetadata(
      creatorcutDirectory,
      backupDirectory,
      restoreSnapshot,
      await safeStageDirectory(creatorcutDirectory, pending.migration_id),
    );
    inject(failureStage, "after_mirrors_replace");
    const restoredBackup = await readVerifiedBackupSnapshot(
      creatorcutDirectory,
      backupDirectory,
    );
    assertPendingBackupBinding(
      restoredBackup,
      pending,
      "Pending rollback backup changed during restoration",
    );
    const restoredEntries = await metadataEntries(
      creatorcutDirectory,
      "backup",
    );
    if (!equalEntries(restoredEntries, restoredBackup.manifest.files)) {
      throw new Error("Authority rollback did not restore exact backup bytes");
    }
    await removeAuthorityStageAndEmptyRoot(
      creatorcutDirectory,
      pending.migration_id,
    );
    await removeEmptyPublicMutationWalUnlocked(creatorcutDirectory);
    await durableRemove(pendingPath);
    return {
      status: "rolled_back",
      project_id: pending.project_id,
      revision: pending.revision,
      migration_id: pending.migration_id,
      authority: "internal-project-store",
      backup_directory: backupDirectory,
      recovered,
    };
  });
}
