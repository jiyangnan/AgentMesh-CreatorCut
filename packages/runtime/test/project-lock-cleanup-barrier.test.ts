import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const cleanupCheckpoint = vi.hoisted(() => ({
  enabled: false,
  mutexObservations: 0,
  cleanupReached: null as (() => void) | null,
  cleanupRelease: Promise.resolve(),
  secondMutexObserved: null as (() => void) | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    realpath: async (path: Parameters<typeof original.realpath>[0]) => {
      const canonical = await original.realpath(path);
      if (
        cleanupCheckpoint.enabled &&
        String(path).endsWith("current-mutex.sqlite")
      ) {
        cleanupCheckpoint.mutexObservations += 1;
        if (cleanupCheckpoint.mutexObservations === 2) {
          cleanupCheckpoint.secondMutexObserved?.();
        }
      }
      return canonical;
    },
    rm: async (
      path: Parameters<typeof original.rm>[0],
      options?: Parameters<typeof original.rm>[1],
    ) => {
      if (cleanupCheckpoint.enabled && String(path).endsWith("active.json")) {
        cleanupCheckpoint.cleanupReached?.();
        await cleanupCheckpoint.cleanupRelease;
      }
      await original.rm(path, options);
    },
  };
});

import { withCreatorCutProjectLock } from "../src/project-lock.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "creatorcut-cleanup-barrier-"));
  const state = join(root, ".creatorcut");
  const lockDirectory = join(state, "project.lock");
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(
    join(lockDirectory, "active.json"),
    JSON.stringify({
      schema_version: "creatorcut-project-lock/1.0",
      pid: 2_147_483_647,
      owner_token: "retired-fixed-owner",
      created_at: "2026-08-09T00:00:00.000Z",
    }),
    "utf8",
  );
  return state;
}

describe("CreatorCut current-writer cleanup handoff", () => {
  it("keeps Q behind P while P cleans a retired fixed active marker", async () => {
    const state = await fixture();
    let releaseCleanup!: () => void;
    let signalCleanupReached!: () => void;
    let signalSecondMutexObserved!: () => void;
    cleanupCheckpoint.enabled = true;
    cleanupCheckpoint.mutexObservations = 0;
    cleanupCheckpoint.cleanupRelease = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanupReached = new Promise<void>((resolve) => {
      signalCleanupReached = resolve;
    });
    const secondMutexObserved = new Promise<void>((resolve) => {
      signalSecondMutexObserved = resolve;
    });
    cleanupCheckpoint.cleanupReached = signalCleanupReached;
    cleanupCheckpoint.secondMutexObserved = signalSecondMutexObserved;

    let releaseP!: () => void;
    let signalPEntered!: () => void;
    const holdP = new Promise<void>((resolve) => {
      releaseP = resolve;
    });
    const pEntered = new Promise<void>((resolve) => {
      signalPEntered = resolve;
    });
    let pIsInside = false;
    let qIsInside = false;
    let activeOperations = 0;
    let maximumActiveOperations = 0;
    const p = withCreatorCutProjectLock(state, async () => {
      pIsInside = true;
      activeOperations += 1;
      maximumActiveOperations = Math.max(
        maximumActiveOperations,
        activeOperations,
      );
      signalPEntered();
      await holdP;
      activeOperations -= 1;
    });

    let q: Promise<void> | null = null;
    try {
      await cleanupReached;
      q = withCreatorCutProjectLock(state, async () => {
        qIsInside = true;
        activeOperations += 1;
        maximumActiveOperations = Math.max(
          maximumActiveOperations,
          activeOperations,
        );
        activeOperations -= 1;
      });
      await secondMutexObserved;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(pIsInside).toBe(false);
      expect(qIsInside).toBe(false);

      releaseCleanup();
      await pEntered;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(pIsInside).toBe(true);
      expect(qIsInside).toBe(false);

      releaseP();
      await Promise.all([p, q]);
      expect(maximumActiveOperations).toBe(1);
    } finally {
      cleanupCheckpoint.enabled = false;
      releaseCleanup();
      releaseP();
      await Promise.allSettled([p, ...(q ? [q] : [])]);
    }
  });
});
