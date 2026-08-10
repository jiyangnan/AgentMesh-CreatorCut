import { lstat, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const workspaceDirectory of ["apps", "packages"]) {
  const workspaceRoot = join(repositoryRoot, workspaceDirectory);
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dist = resolve(workspaceRoot, entry.name, "dist");
    const fromRepository = relative(repositoryRoot, dist);
    if (
      fromRepository === ".." ||
      fromRepository.startsWith(`..${sep}`) ||
      isAbsolute(fromRepository) ||
      !fromRepository.endsWith(`${sep}dist`)
    ) {
      throw new Error(`Refusing to clean an unsafe dist path: ${dist}`);
    }
    const info = await lstat(dist).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Refusing to clean a non-directory dist path: ${dist}`);
    }
    await rm(dist, { recursive: true, force: true });
  }
}
