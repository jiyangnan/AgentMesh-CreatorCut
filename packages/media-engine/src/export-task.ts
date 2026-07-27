import { randomUUID } from "node:crypto";
import { access, link, realpath, rename, rm } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";

import {
  openCreatorCutProject,
  readLocalArtifact,
  writeLocalArtifact,
} from "@agentmesh/creatorcut-runtime";

import { sha256File } from "./import.js";
import { renderTimeline } from "./render.js";
import type { MediaToolOptions, RenderTimelineResult } from "./types.js";

const TASK_PATH = "tasks/export.json";
const LOCATOR_PATH = "tasks/export-locator.json";

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

interface ExportLocator {
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

async function runExportTask(
  projectDirectory: string,
  task: ExportTask,
  locator: ExportLocator,
  options: Pick<MediaToolOptions, "runner" | "signal"> = {},
): Promise<ExportTask> {
  const opened = await openCreatorCutProject(projectDirectory);
  if (
    opened.project.project_id !== task.project_id ||
    opened.project.revision !== task.base_revision
  ) {
    throw new Error(
      "CreatorCut export task is stale after a project revision change",
    );
  }

  try {
    await assertOutputIsSafe(
      opened,
      locator.output_path,
      locator.overwrite,
      task.output_sha256,
    );
    const materialized = await materializeOutput(locator, task);
    if (materialized) {
      await persist(projectDirectory, materialized);
      return materialized;
    }

    const temporary = temporaryOutputPath(locator.output_path, task.task_id);
    await rm(temporary, { force: true });
    const {
      error: _error,
      output_path: _outputPath,
      output_sha256: _outputSha256,
      result: _result,
      ...taskWithoutPriorAttempt
    } = task;
    const running: ExportTask = {
      ...taskWithoutPriorAttempt,
      state: "running",
      progress_millis: 100,
      updated_at: new Date().toISOString(),
    };
    await persist(projectDirectory, running);
    const rendered = await renderTimeline({
      projectDirectory: opened.directory,
      project: opened.project,
      timeline: opened.timeline,
      outputPath: temporary,
      quality: "export",
      overwrite: true,
      ffmpegPath: locator.ffmpeg_path,
      ffprobePath: locator.ffprobe_path,
      ...(options.runner ? { runner: options.runner } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const latestAfterRender = await readExportTask(projectDirectory);
    if (latestAfterRender?.state === "cancelled") {
      throw new Error("CreatorCut export was cancelled");
    }
    const finalizing: ExportTask = {
      ...running,
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
    await persist(projectDirectory, finalizing);
    const completed = await materializeOutput(locator, finalizing);
    if (!completed) {
      throw new Error("CreatorCut export finalization state is missing");
    }
    await persist(projectDirectory, completed);
    return completed;
  } catch (error) {
    const latest = (await readExportTask(projectDirectory)) ?? task;
    const failed: ExportTask = {
      ...latest,
      state: latest.state === "cancelled" ? "cancelled" : "failed",
      updated_at: new Date().toISOString(),
      error: {
        code: "export_failed",
        message: error instanceof Error ? error.message : "Export failed",
      },
    };
    await persist(projectDirectory, failed);
    return failed;
  }
}

export async function startExportTask(
  projectDirectory: string,
  outputPath: string,
  options: MediaToolOptions & { overwrite?: boolean } = {},
): Promise<ExportTask> {
  const opened = await openCreatorCutProject(projectDirectory);
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
  const task = await readExportTask(projectDirectory);
  if (!task) throw new Error("CreatorCut export task is missing");
  if (task.state === "completed") {
    throw new Error("Completed CreatorCut export cannot be cancelled");
  }
  const cancelled: ExportTask = {
    ...task,
    state: "cancelled",
    updated_at: new Date().toISOString(),
  };
  await persist(projectDirectory, cancelled);
  return cancelled;
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
