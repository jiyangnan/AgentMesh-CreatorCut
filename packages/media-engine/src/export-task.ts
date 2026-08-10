import { randomUUID } from "node:crypto";
import {
  access,
  link,
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";

import {
  assertPublicStorageAuthority,
  compareAndSwapLocalArtifact,
  openCreatorCutProject,
  readLocalArtifact,
  verifyMigratedVisualHandoff,
  writeLocalArtifact,
} from "@agentmesh/creatorcut-runtime";
import { digestJcs } from "@agentmesh/creatorcut-protocol";

import { sha256File } from "./import.js";
import { renderTimeline } from "./render.js";
import type { MediaToolOptions, RenderTimelineResult } from "./types.js";

const TASK_PATH = "tasks/export.json";
const LOCATOR_PATH = "tasks/export-locator.json";

interface OutputParentIdentity {
  path: string;
  realPath: string;
  dev: bigint;
  ino: bigint;
}

export interface ExportTask {
  schema_version: "creatorcut-export-task/1.0";
  task_id: string;
  project_id: string;
  base_revision: number;
  state:
    "queued" | "running" | "finalizing" | "completed" | "failed" | "cancelled";
  progress_millis: number;
  output_sha256?: string;
  output_path?: string;
  created_at: string;
  updated_at: string;
  error?: { code: string; message: string };
  result?: RenderTimelineResult;
}

export interface ExportLocator {
  schema_version: "creatorcut-export-locator/1.0";
  output_path: string;
  ffmpeg_path: string;
  ffprobe_path: string;
  overwrite: boolean;
}

async function exists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

function temporaryOutputPath(outputPath: string, taskId: string): string {
  const output = resolve(outputPath);
  const extension = extname(output);
  const stem = basename(output, extension);
  const safeTaskId = taskId.replaceAll(/[^a-zA-Z0-9_-]/gu, "-");
  return resolve(
    dirname(output),
    `.${stem}.creatorcut-${safeTaskId}.partial${extension}`,
  );
}

async function assertOutputIsSafe(
  opened: Awaited<ReturnType<typeof openCreatorCutProject>>,
  outputPath: string,
  overwrite: boolean,
  recoverableSha256?: string,
): Promise<void> {
  const output = resolve(outputPath);
  await assertOutputOutsideState(opened.creatorcutDirectory, output);
  const outputRealPath = await realpath(output).catch(() => null);
  const assetPaths = await Promise.all(
    opened.project.assets.map(async (asset) => {
      const lexical = resolve(opened.directory, asset.relative_path);
      const fromRoot = relative(opened.directory, lexical);
      if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
        throw new Error(
          `Asset escapes the CreatorCut project: ${asset.asset_id}`,
        );
      }
      return {
        lexical,
        real: await realpath(lexical).catch(() => null),
      };
    }),
  );
  if (
    assetPaths.some(
      (asset) =>
        asset.lexical === output ||
        (outputRealPath !== null && asset.real === outputRealPath),
    )
  ) {
    throw new Error("CreatorCut export can never overwrite a project asset");
  }
  if (outputRealPath) {
    const isRecoverable =
      recoverableSha256 !== undefined &&
      (await sha256File(output)) === recoverableSha256;
    if (!overwrite && !isRecoverable) {
      throw new Error("CreatorCut will not overwrite an existing output");
    }
  }
}

async function canonicalFuturePath(path: string): Promise<string> {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (!(await exists(cursor))) {
    missing.unshift(basename(cursor));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return resolve(await realpath(cursor), ...missing);
}

async function assertOutputOutsideState(
  creatorcutDirectory: string,
  outputPath: string,
): Promise<void> {
  const output = await canonicalFuturePath(outputPath);
  const creatorcut = await realpath(creatorcutDirectory);
  const fromCreatorCutState = relative(creatorcut, output);
  if (
    fromCreatorCutState === "" ||
    (!fromCreatorCutState.startsWith("..") && !isAbsolute(fromCreatorCutState))
  ) {
    throw new Error(
      "CreatorCut export output cannot be inside .creatorcut state",
    );
  }
}

async function assertVisualExportSupported(
  projectDirectory: string,
  opened: Awaited<ReturnType<typeof openCreatorCutProject>>,
): Promise<void> {
  if (opened.visualComposition) {
    throw new Error(
      "CreatorCut export is blocked because the public renderer cannot materialize the active visual composition",
    );
  }
  const authority = await assertPublicStorageAuthority(
    opened.creatorcutDirectory,
  );
  if (
    authority.source_format === "creatorcut-internal-project-store/1.0-alpha"
  ) {
    const handoff = await verifyMigratedVisualHandoff(projectDirectory);
    if (handoff.visual_handoff_present) {
      throw new Error(
        "CreatorCut export is blocked because the public renderer cannot materialize the migrated visual handoff",
      );
    }
  }
}

async function captureOutputParent(
  outputPath: string,
): Promise<OutputParentIdentity> {
  const parent = resolve(dirname(outputPath));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const info = await lstat(parent, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(
      "CreatorCut export output parent is not a trusted local directory",
    );
  }
  return {
    path: parent,
    realPath: await realpath(parent),
    dev: info.dev,
    ino: info.ino,
  };
}

async function assertOutputParent(
  identity: OutputParentIdentity,
): Promise<void> {
  const info = await lstat(identity.path, { bigint: true });
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.dev !== identity.dev ||
    info.ino !== identity.ino ||
    (await realpath(identity.path)) !== identity.realPath
  ) {
    throw new Error(
      "CreatorCut export output parent changed before final publish",
    );
  }
}

async function compareAndSwapExportTask<V>(
  projectDirectory: string,
  opened: Awaited<ReturnType<typeof openCreatorCutProject>>,
  expected: ExportTask,
  operation: (current: ExportTask) => Promise<{ next: ExportTask; value: V }>,
): Promise<{ task: ExportTask; value: V; authorityGeneration: number }> {
  const completed = await compareAndSwapLocalArtifact<ExportTask, V>(
    projectDirectory,
    TASK_PATH,
    {
      projectId: opened.project.project_id,
      revision: opened.project.revision,
      authorityGeneration: opened.authorityGeneration,
      artifactDigest: digestJcs(expected),
    },
    async ({ currentArtifact }) => {
      if (
        !currentArtifact ||
        currentArtifact.task_id !== expected.task_id ||
        currentArtifact.project_id !== expected.project_id ||
        currentArtifact.base_revision !== expected.base_revision ||
        currentArtifact.state !== expected.state
      ) {
        throw new Error(
          "CreatorCut export task compare-and-swap state changed",
        );
      }
      const result = await operation(currentArtifact);
      return { nextArtifact: result.next, value: result.value };
    },
  );
  return {
    task: completed.artifact,
    value: completed.value,
    authorityGeneration: completed.authorityGeneration,
  };
}

async function persist(
  projectDirectory: string,
  task: ExportTask,
): Promise<void> {
  await writeLocalArtifact(projectDirectory, TASK_PATH, task);
}

function completedTask(task: ExportTask): ExportTask {
  const { error: _error, ...taskWithoutError } = task;
  return {
    ...taskWithoutError,
    state: "completed",
    progress_millis: 1000,
    updated_at: new Date().toISOString(),
  };
}

async function materializeOutput(
  locator: ExportLocator,
  task: ExportTask,
): Promise<ExportTask | null> {
  if (!task.result || !task.output_sha256 || !task.output_path) return null;
  const output = resolve(locator.output_path);
  const temporary = temporaryOutputPath(output, task.task_id);
  const expectedSha256 = task.output_sha256;

  if (await exists(output)) {
    if ((await sha256File(output)) === expectedSha256) {
      await rm(temporary, { force: true });
      return completedTask(task);
    }
    if (!locator.overwrite) {
      throw new Error("CreatorCut will not overwrite an existing output");
    }
  }

  if (!(await exists(temporary))) return null;
  if ((await sha256File(temporary)) !== expectedSha256) {
    throw new Error("CreatorCut interrupted export bytes are invalid");
  }

  if (locator.overwrite) {
    await rename(temporary, output);
  } else {
    try {
      await link(temporary, output);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        (await sha256File(output).catch(() => null)) !== expectedSha256
      ) {
        throw new Error("CreatorCut will not overwrite an existing output", {
          cause: error,
        });
      }
    }
    await rm(temporary, { force: true });
  }
  if ((await sha256File(output)) !== expectedSha256) {
    throw new Error("CreatorCut materialized export failed validation");
  }
  return completedTask(task);
}

export async function runExportTask(
  projectDirectory: string,
  task: ExportTask,
  locator: ExportLocator,
  options: Pick<MediaToolOptions, "runner" | "signal"> = {},
): Promise<ExportTask> {
  const initialOpened = await openCreatorCutProject(projectDirectory);
  await assertVisualExportSupported(projectDirectory, initialOpened);
  if (
    initialOpened.project.project_id !== task.project_id ||
    initialOpened.project.revision !== task.base_revision
  ) {
    throw new Error(
      "CreatorCut export task is stale after a project revision change",
    );
  }
  await assertOutputOutsideState(
    initialOpened.creatorcutDirectory,
    locator.output_path,
  );

  try {
    const stored = await readExportTask(projectDirectory);
    if (
      !stored ||
      stored.task_id !== task.task_id ||
      stored.project_id !== task.project_id ||
      stored.base_revision !== task.base_revision
    ) {
      throw new Error("CreatorCut export task identity changed");
    }
    await assertOutputIsSafe(
      initialOpened,
      locator.output_path,
      locator.overwrite,
      stored.output_sha256,
    );
    const outputParent = await captureOutputParent(locator.output_path);

    if (stored.result && stored.output_sha256 && stored.output_path) {
      const recoveryOpened = await openCreatorCutProject(projectDirectory);
      const recoveryTransition =
        stored.state === "finalizing"
          ? {
              task: stored,
              authorityGeneration: recoveryOpened.authorityGeneration,
            }
          : await compareAndSwapExportTask(
              projectDirectory,
              recoveryOpened,
              stored,
              async (current) => ({
                next: {
                  ...current,
                  state: "finalizing",
                  progress_millis: 900,
                  updated_at: new Date().toISOString(),
                },
                value: undefined,
              }),
            );
      const recovering = recoveryTransition.task;
      const finalOpened = {
        ...recoveryOpened,
        authorityGeneration: recoveryTransition.authorityGeneration,
      };
      return (
        await compareAndSwapExportTask(
          projectDirectory,
          finalOpened,
          recovering,
          async (current) => {
            await assertOutputParent(outputParent);
            await assertOutputIsSafe(
              finalOpened,
              locator.output_path,
              locator.overwrite,
              current.output_sha256,
            );
            const completed = await materializeOutput(locator, current);
            if (!completed) {
              throw new Error(
                "CreatorCut export finalization state is missing",
              );
            }
            return { next: completed, value: completed };
          },
        )
      ).value;
    }

    const temporary = temporaryOutputPath(locator.output_path, task.task_id);
    await rm(temporary, { force: true });
    const {
      error: _error,
      output_path: _outputPath,
      output_sha256: _outputSha256,
      result: _result,
      ...taskWithoutPriorAttempt
    } = stored;
    const runningOpened = await openCreatorCutProject(projectDirectory);
    const runningTransition = await compareAndSwapExportTask(
      projectDirectory,
      runningOpened,
      stored,
      async () => {
        const next: ExportTask = {
          ...taskWithoutPriorAttempt,
          state: "running",
          progress_millis: 100,
          updated_at: new Date().toISOString(),
        };
        return { next, value: next };
      },
    );
    const running = runningTransition.value;
    const rendered = await renderTimeline({
      projectDirectory: runningOpened.directory,
      project: runningOpened.project,
      timeline: runningOpened.timeline,
      outputPath: temporary,
      quality: "export",
      overwrite: true,
      ffmpegPath: locator.ffmpeg_path,
      ffprobePath: locator.ffprobe_path,
      ...(options.runner ? { runner: options.runner } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const finalizingOpened = {
      ...runningOpened,
      authorityGeneration: runningTransition.authorityGeneration,
    };
    const finalizingTransition = await compareAndSwapExportTask(
      projectDirectory,
      finalizingOpened,
      running,
      async (current) => {
        const next: ExportTask = {
          ...current,
          state: "finalizing",
          progress_millis: 900,
          output_sha256: rendered.output_sha256,
          output_path: resolve(locator.output_path),
          result: {
            ...rendered,
            output_path: resolve(locator.output_path),
          },
          updated_at: new Date().toISOString(),
        };
        return { next, value: next };
      },
    );
    const finalizing = finalizingTransition.value;
    const completedOpened = {
      ...runningOpened,
      authorityGeneration: finalizingTransition.authorityGeneration,
    };
    return (
      await compareAndSwapExportTask(
        projectDirectory,
        completedOpened,
        finalizing,
        async (current) => {
          await assertOutputParent(outputParent);
          await assertOutputIsSafe(
            completedOpened,
            locator.output_path,
            locator.overwrite,
            current.output_sha256,
          );
          const completed = await materializeOutput(locator, current);
          if (!completed) {
            throw new Error("CreatorCut export finalization state is missing");
          }
          return { next: completed, value: completed };
        },
      )
    ).value;
  } catch (error) {
    let latest: ExportTask | null;
    try {
      latest = await readExportTask(projectDirectory);
    } catch (artifactError) {
      const currentOpened = await openCreatorCutProject(projectDirectory).catch(
        () => null,
      );
      if (
        currentOpened &&
        (currentOpened.project.project_id !== task.project_id ||
          currentOpened.project.revision !== task.base_revision)
      ) {
        return {
          ...task,
          state: "failed",
          updated_at: new Date().toISOString(),
          error: {
            code: "export_failed",
            message: error instanceof Error ? error.message : "Export failed",
          },
        };
      }
      throw artifactError;
    }
    if (latest?.state === "cancelled" || latest?.state === "completed") {
      return latest;
    }
    const failed: ExportTask = {
      ...(latest?.task_id === task.task_id ? latest : task),
      state: "failed",
      updated_at: new Date().toISOString(),
      error: {
        code: "export_failed",
        message: error instanceof Error ? error.message : "Export failed",
      },
    };
    if (latest?.task_id !== task.task_id) return failed;
    const currentOpened = await openCreatorCutProject(projectDirectory).catch(
      () => null,
    );
    if (
      !currentOpened ||
      currentOpened.project.project_id !== task.project_id ||
      currentOpened.project.revision !== task.base_revision
    ) {
      return failed;
    }
    try {
      return (
        await compareAndSwapExportTask(
          projectDirectory,
          currentOpened,
          latest,
          async () => ({ next: failed, value: failed }),
        )
      ).value;
    } catch {
      const raced = await readExportTask(projectDirectory);
      if (raced?.state === "cancelled" || raced?.state === "completed") {
        return raced;
      }
    }
    return failed;
  }
}

export async function startExportTask(
  projectDirectory: string,
  outputPath: string,
  options: MediaToolOptions & { overwrite?: boolean } = {},
): Promise<ExportTask> {
  const opened = await openCreatorCutProject(projectDirectory);
  await assertVisualExportSupported(projectDirectory, opened);
  await assertOutputOutsideState(opened.creatorcutDirectory, outputPath);
  const now = new Date().toISOString();
  const task: ExportTask = {
    schema_version: "creatorcut-export-task/1.0",
    task_id: `export:${randomUUID()}`,
    project_id: opened.project.project_id,
    base_revision: opened.project.revision,
    state: "queued",
    progress_millis: 0,
    created_at: now,
    updated_at: now,
  };
  await persist(projectDirectory, task);
  const locator = {
    schema_version: "creatorcut-export-locator/1.0",
    output_path: resolve(outputPath),
    ffmpeg_path: options.ffmpegPath ?? "ffmpeg",
    ffprobe_path: options.ffprobePath ?? "ffprobe",
    overwrite: options.overwrite ?? false,
  } satisfies ExportLocator;
  await writeLocalArtifact(projectDirectory, LOCATOR_PATH, locator);
  return runExportTask(projectDirectory, task, locator, options);
}

export function readExportTask(
  projectDirectory: string,
): Promise<ExportTask | null> {
  return readLocalArtifact<ExportTask>(projectDirectory, TASK_PATH);
}

export async function cancelExportTask(
  projectDirectory: string,
): Promise<ExportTask> {
  const opened = await openCreatorCutProject(projectDirectory);
  const task = await readExportTask(projectDirectory);
  if (!task) throw new Error("CreatorCut export task is missing");
  if (task.state === "completed") {
    throw new Error("Completed CreatorCut export cannot be cancelled");
  }
  if (task.state === "cancelled") return task;
  return (
    await compareAndSwapExportTask(
      projectDirectory,
      opened,
      task,
      async (current) => {
        const cancelled: ExportTask = {
          ...current,
          state: "cancelled",
          updated_at: new Date().toISOString(),
        };
        return { next: cancelled, value: cancelled };
      },
    )
  ).value;
}

export async function resumeExportTask(
  projectDirectory: string,
  options: Pick<MediaToolOptions, "runner" | "signal"> = {},
): Promise<ExportTask> {
  const task = await readExportTask(projectDirectory);
  const locator = await readLocalArtifact<ExportLocator>(
    projectDirectory,
    LOCATOR_PATH,
  );
  if (!task || !locator)
    throw new Error("CreatorCut export recovery state is missing");
  if (task.state === "completed") return task;
  return runExportTask(projectDirectory, task, locator, options);
}
