import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { platform } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

interface PrivateDirectoryIdentity {
  path: string;
  handle: FileHandle;
  dev: bigint;
  ino: bigint;
}

export interface PrivateWorkDirectoryLease {
  projectDirectory: string;
  rootDirectory: string;
  directory: string;
  identities: readonly PrivateDirectoryIdentity[];
}

function contained(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return (
    value.length > 0 &&
    value !== ".." &&
    !value.startsWith(`..${sep}`) &&
    !isAbsolute(value)
  );
}

function assertSegment(segment: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(segment)) {
    throw new TypeError("CreatorCut private work segment is unsafe");
  }
}

async function tightenPrivatePosixMode(
  handle: FileHandle,
  mode: number,
  expected: { dev: bigint; ino: bigint },
): Promise<void> {
  // chmod/fchmod does not establish a Windows DACL and directory fchmod is
  // rejected with EPERM by Node 24. Windows keeps the no-follow/identity
  // boundary below and inherits the project's ACL; POSIX hosts
  // additionally tighten the opened inode itself.
  if (platform() === "win32") return;
  if (typeof process.getuid !== "function") {
    throw new Error("CreatorCut cannot verify the private work owner");
  }
  const uid = BigInt(process.getuid());
  const before = await handle.stat({ bigint: true });
  if (
    before.dev !== expected.dev ||
    before.ino !== expected.ino ||
    before.uid !== uid
  ) {
    throw new Error("CreatorCut private work owner or identity changed");
  }
  await handle.chmod(mode);
  const after = await handle.stat({ bigint: true });
  if (
    after.dev !== expected.dev ||
    after.ino !== expected.ino ||
    after.uid !== uid ||
    (after.mode & 0o777n) !== BigInt(mode)
  ) {
    throw new Error("CreatorCut private work mode or identity changed");
  }
}

async function openDirectoryIdentity(
  path: string,
  expectedDevice: bigint,
): Promise<PrivateDirectoryIdentity> {
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new TypeError(
      "CreatorCut private work path contains a symbolic link or non-directory",
    );
  }
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isDirectory() ||
      opened.dev !== expectedDevice ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      (await realpath(path)) !== path
    ) {
      throw new Error(
        "CreatorCut private work directory changed while opening",
      );
    }
    return { path, handle, dev: opened.dev, ino: opened.ino };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertIdentities(
  identities: readonly PrivateDirectoryIdentity[],
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
      throw new Error("CreatorCut private work directory identity changed");
    }
  }
}

export async function preparePrivateWorkDirectory(
  projectDirectory: string,
  segments: readonly string[],
): Promise<PrivateWorkDirectoryLease> {
  if (segments.length === 0) {
    throw new TypeError("CreatorCut private work namespace is required");
  }
  for (const segment of segments) assertSegment(segment);
  const project = await realpath(resolve(projectDirectory));
  const projectInfo = await lstat(project, { bigint: true });
  if (projectInfo.isSymbolicLink() || !projectInfo.isDirectory()) {
    throw new TypeError("CreatorCut project path is not a directory");
  }
  const root = join(project, ".creatorcut-work");
  const paths = [root];
  let cursor = root;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    paths.push(cursor);
  }
  if (
    !contained(project, root) ||
    paths.some((path) => !contained(project, path))
  ) {
    throw new TypeError("CreatorCut private work path escapes the project");
  }

  const identities: PrivateDirectoryIdentity[] = [];
  try {
    for (const path of paths) {
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new TypeError(
            "CreatorCut private work path contains a symbolic link or non-directory",
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(path, { mode: 0o700 });
      }
      const identity = await openDirectoryIdentity(path, projectInfo.dev);
      identities.push(identity);
      await tightenPrivatePosixMode(identity.handle, 0o700, identity);
      await assertIdentities(identities);
    }
    return {
      projectDirectory: project,
      rootDirectory: root,
      directory: paths.at(-1)!,
      identities,
    };
  } catch (error) {
    await Promise.allSettled(
      identities.reverse().map((identity) => identity.handle.close()),
    );
    throw error;
  }
}

export function privateWorkPath(
  lease: PrivateWorkDirectoryLease,
  fileName: string,
): string {
  assertSegment(fileName);
  const path = resolve(lease.directory, fileName);
  if (!contained(lease.directory, path)) {
    throw new TypeError("CreatorCut private work file escapes its namespace");
  }
  return path;
}

export async function assertPrivateWorkDirectory(
  lease: PrivateWorkDirectoryLease,
): Promise<void> {
  await assertIdentities(lease.identities);
}

export async function finalizePrivateWorkFile(
  lease: PrivateWorkDirectoryLease,
  filePath: string,
): Promise<void> {
  const path = resolve(filePath);
  if (
    !contained(lease.directory, path) ||
    resolve(join(path, "..")) !== lease.directory
  ) {
    throw new TypeError("CreatorCut private work file escapes its namespace");
  }
  await assertPrivateWorkDirectory(lease);
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const namespace = lease.identities.at(-1)!;
    const identity = await assertPrivateWorkFileIdentity(
      handle,
      path,
      namespace.dev,
    );
    await assertPrivateWorkDirectory(lease);
    await tightenPrivatePosixMode(handle, 0o600, identity);
    await assertPrivateWorkDirectory(lease);
    await assertPrivateWorkFileIdentity(handle, path, namespace.dev);
  } finally {
    await handle.close();
  }
  await assertPrivateWorkDirectory(lease);
}

async function assertPrivateWorkFileIdentity(
  handle: FileHandle,
  path: string,
  expectedDevice: bigint,
): Promise<{ dev: bigint; ino: bigint }> {
  const opened = await handle.stat({ bigint: true });
  const current = await lstat(path, { bigint: true });
  if (
    !opened.isFile() ||
    opened.nlink !== 1n ||
    opened.dev !== expectedDevice ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.nlink !== 1n ||
    opened.dev !== current.dev ||
    opened.ino !== current.ino ||
    (await realpath(path)) !== path
  ) {
    throw new Error("CreatorCut private work file identity changed");
  }
  return { dev: opened.dev, ino: opened.ino };
}

export async function releasePrivateWorkDirectory(
  lease: PrivateWorkDirectoryLease,
): Promise<void> {
  await Promise.allSettled(
    [...lease.identities].reverse().map((identity) => identity.handle.close()),
  );
}

export async function removePrivateWorkNamespace(
  projectDirectory: string,
  namespace: string,
): Promise<void> {
  const lease = await preparePrivateWorkDirectory(projectDirectory, [
    namespace,
  ]);
  try {
    await assertPrivateWorkDirectory(lease);
    await rm(lease.directory, { recursive: true, force: true });
  } finally {
    await releasePrivateWorkDirectory(lease);
  }
}
