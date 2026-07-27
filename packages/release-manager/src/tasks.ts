import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ActiveProjectTask } from "./types.js";

const ACTIVE_STATES = new Set(["queued", "running", "finalizing"]);

async function activeTask(
  projectDirectory: string,
  kind: ActiveProjectTask["kind"],
): Promise<ActiveProjectTask | null> {
  const path = resolve(
    projectDirectory,
    ".creatorcut",
    "tasks",
    `${kind}.json`,
  );
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new TypeError(`CreatorCut ${kind} task state is unreadable`, {
      cause: error,
    });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`CreatorCut ${kind} task state is invalid`);
  }
  const state = (value as Record<string, unknown>).state;
  if (typeof state !== "string") {
    throw new TypeError(`CreatorCut ${kind} task state is invalid`);
  }
  if (!ACTIVE_STATES.has(state)) return null;
  return {
    kind,
    state: state as ActiveProjectTask["state"],
    path,
  };
}

export async function findActiveProjectTasks(
  projectDirectory: string,
): Promise<ActiveProjectTask[]> {
  const tasks = await Promise.all([
    activeTask(projectDirectory, "transcription"),
    activeTask(projectDirectory, "export"),
  ]);
  return tasks.filter((task): task is ActiveProjectTask => task !== null);
}
