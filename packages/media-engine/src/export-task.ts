import { randomUUID } from "node:crypto";

import {
  openCreatorCutProject,
  readLocalArtifact,
  writeLocalArtifact,
} from "@agentmesh/creatorcut-runtime";

import { renderTimeline } from "./render.js";
import type { MediaToolOptions, RenderTimelineResult } from "./types.js";

const TASK_PATH = "tasks/export.json";
const LOCATOR_PATH = "tasks/export-locator.json";

export interface ExportTask {
  schema_version: "creatorcut-export-task/1.0";
  task_id: string;
  project_id: string;
  base_revision: number;
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
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

async function persist(
  projectDirectory: string,
  task: ExportTask,
): Promise<void> {
  await writeLocalArtifact(projectDirectory, TASK_PATH, task);
}

export async function startExportTask(
  projectDirectory: string,
  outputPath: string,
  options: MediaToolOptions & { overwrite?: boolean } = {},
): Promise<ExportTask> {
  const opened = await openCreatorCutProject(projectDirectory);
  const now = new Date().toISOString();
  let task: ExportTask = {
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
  await writeLocalArtifact(projectDirectory, LOCATOR_PATH, {
    schema_version: "creatorcut-export-locator/1.0",
    output_path: outputPath,
    ffmpeg_path: options.ffmpegPath ?? "ffmpeg",
    ffprobe_path: options.ffprobePath ?? "ffprobe",
    overwrite: options.overwrite ?? false,
  } satisfies ExportLocator);
  task = {
    ...task,
    state: "running",
    progress_millis: 100,
    updated_at: new Date().toISOString(),
  };
  await persist(projectDirectory, task);
  try {
    const result = await renderTimeline({
      ...options,
      projectDirectory: opened.directory,
      project: opened.project,
      timeline: opened.timeline,
      outputPath,
      quality: "export",
      overwrite: options.overwrite ?? false,
    });
    const latest = await readExportTask(projectDirectory);
    if (latest?.state === "cancelled") {
      throw new Error("CreatorCut export was cancelled");
    }
    const completed: ExportTask = {
      ...task,
      state: "completed",
      progress_millis: 1000,
      output_sha256: result.output_sha256,
      output_path: result.output_path,
      updated_at: new Date().toISOString(),
      result,
    };
    await persist(projectDirectory, completed);
    return completed;
  } catch (error) {
    const latest = await readExportTask(projectDirectory);
    const failed: ExportTask = {
      ...task,
      state: latest?.state === "cancelled" ? "cancelled" : "failed",
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
  const opened = await openCreatorCutProject(projectDirectory);
  if (opened.project.revision !== task.base_revision) {
    throw new Error(
      "CreatorCut export task is stale after a project revision change",
    );
  }
  return startExportTask(projectDirectory, locator.output_path, {
    ffmpegPath: locator.ffmpeg_path,
    ffprobePath: locator.ffprobe_path,
    overwrite: locator.overwrite,
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
