import { lstat, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = resolve(dirname(scriptPath), "..");

async function pathInfo(path) {
  return await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

export async function cleanWorkspaceDist({
  repositoryRoot = defaultRepositoryRoot,
  workspaceDirectory = process.cwd(),
} = {}) {
  const resolvedRepositoryRoot = await realpath(resolve(repositoryRoot));
  const requestedWorkspace = resolve(workspaceDirectory);
  const requestedInfo = await pathInfo(requestedWorkspace);
  if (
    !requestedInfo ||
    requestedInfo.isSymbolicLink() ||
    !requestedInfo.isDirectory()
  ) {
    throw new Error(
      `Refusing to clean a missing or unsafe workspace: ${requestedWorkspace}`,
    );
  }

  const resolvedWorkspace = await realpath(requestedWorkspace);
  const fromRepository = relative(resolvedRepositoryRoot, resolvedWorkspace);
  const parts = fromRepository.split(sep);
  if (
    fromRepository === ".." ||
    fromRepository.startsWith(`..${sep}`) ||
    isAbsolute(fromRepository) ||
    parts.length !== 2 ||
    !["apps", "packages"].includes(parts[0]) ||
    !parts[1]
  ) {
    throw new Error(
      `Refusing to clean a non-workspace directory: ${requestedWorkspace}`,
    );
  }

  const packageManifest = join(resolvedWorkspace, "package.json");
  const manifestInfo = await pathInfo(packageManifest);
  if (
    !manifestInfo ||
    manifestInfo.isSymbolicLink() ||
    !manifestInfo.isFile()
  ) {
    throw new Error(
      `Refusing to clean a workspace without a regular package.json: ${requestedWorkspace}`,
    );
  }

  const dist = join(resolvedWorkspace, "dist");
  const distInfo = await pathInfo(dist);
  if (!distInfo) return;
  if (distInfo.isSymbolicLink() || !distInfo.isDirectory()) {
    throw new Error(`Refusing to clean a non-directory dist path: ${dist}`);
  }
  await rm(dist, { recursive: true, force: true });
}

const invokedPath = process.argv[1]
  ? await realpath(resolve(process.argv[1])).catch(() => null)
  : null;
const loadedPath = await realpath(scriptPath);
if (invokedPath === loadedPath) {
  await cleanWorkspaceDist();
}
