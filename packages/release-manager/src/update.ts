import { createHash } from "node:crypto";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

import { findActiveProjectTasks } from "./tasks.js";
import type {
  ManagedInstallMetadata,
  RunCommand,
  VerifiedReleaseManifest,
} from "./types.js";

export class ManagedUpdateError extends Error {}

const OFFICIAL_REPOSITORIES = new Set([
  "https://github.com/jiyangnan/AgentMesh-CreatorCut.git",
  "git@github.com:jiyangnan/AgentMesh-CreatorCut.git",
]);

function decode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8").trim();
}

export const defaultRunCommand: RunCommand = async (input) => {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolvePromise({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
};

async function runChecked(
  run: RunCommand,
  cwd: string,
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<Uint8Array> {
  const result = await run({
    cwd,
    command,
    args,
    ...(env === undefined ? {} : { env }),
  });
  if (result.exitCode !== 0) {
    throw new ManagedUpdateError(
      decode(result.stderr) ||
        `CreatorCut update command failed: ${command} ${args.join(" ")}`,
    );
  }
  return result.stdout;
}

function managedMetadata(value: unknown): ManagedInstallMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagedUpdateError(
      "CreatorCut source checkout is not an official managed install",
    );
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schema_version !== "creatorcut-managed-install/1.0" ||
    candidate.managed !== true ||
    candidate.install_type !== "official-installer"
  ) {
    throw new ManagedUpdateError(
      "CreatorCut source checkout is not an official managed install",
    );
  }
  for (const name of [
    "repository",
    "install_dir",
    "version",
    "git_tag",
    "git_commit",
    "artifact_sha256",
    "installed_at",
  ]) {
    if (typeof candidate[name] !== "string" || candidate[name] === "") {
      throw new ManagedUpdateError(
        "CreatorCut managed install metadata is invalid",
      );
    }
  }
  if (
    !Number.isSafeInteger(candidate.release_keyset_version) ||
    Number(candidate.release_keyset_version) <= 0
  ) {
    throw new ManagedUpdateError(
      "CreatorCut managed install metadata is invalid",
    );
  }
  return candidate as unknown as ManagedInstallMetadata;
}

export async function readManagedInstallMetadata(
  metadataPath: string,
): Promise<ManagedInstallMetadata> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
  } catch (error) {
    throw new ManagedUpdateError(
      "CreatorCut source checkout is not an official managed install",
      { cause: error },
    );
  }
  return managedMetadata(value);
}

async function writeMetadata(
  path: string,
  metadata: ManagedInstallMetadata,
): Promise<void> {
  const temporary = `${path}.next-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function installAndBuild(run: RunCommand, root: string): Promise<void> {
  await runChecked(run, root, "corepack", [
    "pnpm",
    "install",
    "--frozen-lockfile",
  ]);
  await runChecked(run, root, "corepack", ["pnpm", "build"]);
}

export async function applyManagedUpdate(input: {
  manifest: VerifiedReleaseManifest;
  releaseKeysetVersion: number;
  metadataPath: string;
  projectDirectory?: string;
  run?: RunCommand;
  platform?: NodeJS.Platform;
  allowedRepositories?: ReadonlySet<string>;
  now?: Date;
}): Promise<ManagedInstallMetadata> {
  if ((input.platform ?? process.platform) !== "darwin") {
    throw new ManagedUpdateError(
      "CreatorCut M1 managed updates currently support macOS only",
    );
  }
  const metadataPath = resolve(input.metadataPath);
  const metadata = await readManagedInstallMetadata(metadataPath);
  if (
    !Number.isSafeInteger(input.releaseKeysetVersion) ||
    input.releaseKeysetVersion < metadata.release_keyset_version
  ) {
    throw new ManagedUpdateError(
      "CreatorCut release keyset rollback was rejected",
    );
  }
  const root = resolve(metadata.install_dir);
  if (dirname(metadataPath) !== root) {
    throw new ManagedUpdateError(
      "CreatorCut managed install metadata is outside the install root",
    );
  }
  if (input.projectDirectory) {
    const activeTasks = await findActiveProjectTasks(input.projectDirectory);
    if (activeTasks.length > 0) {
      throw new ManagedUpdateError(
        `CreatorCut update deferred while ${activeTasks
          .map((task) => `${task.kind}:${task.state}`)
          .join(", ")} is active`,
      );
    }
  }

  const lockPath = resolve(root, ".creatorcut-update.lock");
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ManagedUpdateError(
        "Another CreatorCut managed update is already running",
      );
    }
    throw error;
  }
  await lock.writeFile(String(process.pid), "utf8");
  await lock.close();

  const run = input.run ?? defaultRunCommand;
  const allowed = input.allowedRepositories ?? OFFICIAL_REPOSITORIES;
  let oldCommit = "";
  let checkoutChanged = false;
  try {
    const origin = decode(
      await runChecked(run, root, "git", ["remote", "get-url", "origin"]),
    );
    if (origin !== metadata.repository || !allowed.has(origin)) {
      throw new ManagedUpdateError(
        "CreatorCut managed install origin is not the official repository",
      );
    }
    const dirty = decode(
      await runChecked(run, root, "git", [
        "status",
        "--porcelain",
        "--untracked-files=no",
      ]),
    );
    if (dirty) {
      throw new ManagedUpdateError(
        "CreatorCut managed install has local changes; update refused",
      );
    }
    oldCommit = decode(
      await runChecked(run, root, "git", ["rev-parse", "HEAD"]),
    );
    await runChecked(run, root, "git", [
      "fetch",
      "--force",
      "--tags",
      "origin",
      input.manifest.git_tag,
    ]);
    const tagCommit = decode(
      await runChecked(run, root, "git", [
        "rev-parse",
        `${input.manifest.git_tag}^{commit}`,
      ]),
    );
    if (tagCommit !== input.manifest.git_commit) {
      throw new ManagedUpdateError(
        "CreatorCut release tag does not resolve to the signed commit",
      );
    }
    const archive = await runChecked(
      run,
      root,
      "git",
      [
        "-c",
        "tar.umask=002",
        "-c",
        "core.attributesFile=/dev/null",
        "archive",
        "--format=tar",
        tagCommit,
      ],
      {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
      },
    );
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest !== input.manifest.artifact_sha256) {
      throw new ManagedUpdateError("CreatorCut release artifact hash mismatch");
    }

    await runChecked(run, root, "git", [
      "checkout",
      "--detach",
      input.manifest.git_commit,
    ]);
    checkoutChanged = true;
    await installAndBuild(run, root);
    const smoke = decode(
      await runChecked(run, root, "node", [
        "apps/cli/dist/src/main.js",
        "version",
      ]),
    );
    const smokeValue = JSON.parse(smoke) as {
      ok?: boolean;
      data?: { version?: string };
    };
    if (
      smokeValue.ok !== true ||
      smokeValue.data?.version !== input.manifest.latest_client_version
    ) {
      throw new ManagedUpdateError(
        "Updated CreatorCut CLI smoke check returned the wrong version",
      );
    }
    const updated: ManagedInstallMetadata = {
      ...metadata,
      version: input.manifest.latest_client_version,
      git_tag: input.manifest.git_tag,
      git_commit: input.manifest.git_commit,
      artifact_sha256: input.manifest.artifact_sha256,
      release_keyset_version: input.releaseKeysetVersion,
      installed_at: (input.now ?? new Date()).toISOString(),
    };
    await writeMetadata(metadataPath, updated);
    return updated;
  } catch (error) {
    if (checkoutChanged && oldCommit) {
      try {
        await runChecked(run, root, "git", ["checkout", "--detach", oldCommit]);
        await installAndBuild(run, root);
      } catch (rollbackError) {
        throw new ManagedUpdateError(
          `CreatorCut update failed and rollback also failed: ${
            rollbackError instanceof Error
              ? rollbackError.message
              : "unknown rollback error"
          }`,
          { cause: error },
        );
      }
      throw new ManagedUpdateError(
        `CreatorCut update failed and was rolled back: ${
          error instanceof Error ? error.message : "unknown update error"
        }`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    await rm(lockPath, { force: true });
  }
}
