import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

const publishCheckpoint = vi.hoisted(() => ({
  enabled: false,
  intercepted: false,
  reached: null as (() => void) | null,
  release: Promise.resolve(),
  published: null as (() => void) | null,
  pauseAfterPublish: false,
  afterPublishRelease: Promise.resolve(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    rename: async (
      oldPath: Parameters<typeof original.rename>[0],
      newPath: Parameters<typeof original.rename>[1],
    ) => {
      const source = String(oldPath);
      const destination = String(newPath);
      const publishesContender =
        /[\\/]\.creating[\\/]/u.test(source) &&
        !/[\\/]\.creating[\\/]/u.test(destination) &&
        destination.endsWith(".json");
      if (
        publishCheckpoint.enabled &&
        !publishCheckpoint.intercepted &&
        publishesContender
      ) {
        publishCheckpoint.intercepted = true;
        publishCheckpoint.reached?.();
        await publishCheckpoint.release;
        await original.rename(oldPath, newPath);
        publishCheckpoint.published?.();
        if (publishCheckpoint.pauseAfterPublish) {
          await publishCheckpoint.afterPublishRelease;
        }
        return;
      }
      await original.rename(oldPath, newPath);
    },
  };
});

import { withCreatorCutProjectLock } from "../src/project-lock.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "creatorcut-publish-barrier-"));
  const state = join(root, ".creatorcut");
  await mkdir(state);
  return state;
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    if (
      await access(path)
        .then(() => true)
        .catch(() => false)
    )
      return;
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
}

async function childResult(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveExit, rejectExit) => {
    let output = "";
    child.stdout?.on("data", (value: Buffer) => {
      output += value.toString("utf8");
    });
    child.stderr?.on("data", (value: Buffer) => {
      output += value.toString("utf8");
    });
    child.on("error", rejectExit);
    child.on("close", (code) => resolveExit({ code, output }));
  });
}

describe("CreatorCut current/frozen publish barrier", () => {
  it("waits for a frozen operation that enters between the empty scan and guard publish", async () => {
    const state = await fixture();
    const frozenEntered = join(state, "frozen-entered");
    const releaseFrozen = join(state, "release-frozen");
    const script = fileURLToPath(
      new URL("./fixtures/legacy-v1-lock-contender.mjs", import.meta.url),
    );
    let releasePublish!: () => void;
    let publishReached!: () => void;
    let publishCompleted!: () => void;
    publishCheckpoint.enabled = true;
    publishCheckpoint.intercepted = false;
    publishCheckpoint.pauseAfterPublish = false;
    publishCheckpoint.afterPublishRelease = Promise.resolve();
    publishCheckpoint.release = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      publishReached = resolve;
    });
    const published = new Promise<void>((resolve) => {
      publishCompleted = resolve;
    });
    publishCheckpoint.reached = publishReached;
    publishCheckpoint.published = publishCompleted;

    let releaseCurrent!: () => void;
    let currentEntered = false;
    const currentGate = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const current = withCreatorCutProjectLock(state, async () => {
      currentEntered = true;
      await currentGate;
    });
    let frozen: ReturnType<typeof spawn> | null = null;
    try {
      await reached;
      const frozenProcess = spawn(
        process.execPath,
        [script, state, frozenEntered],
        {
          env: {
            ...process.env,
            CREATORCUT_FROZEN_EXPECT_ENTRY: "1",
            CREATORCUT_FROZEN_FORCE_EQUAL_BIRTHTIME: "1",
            CREATORCUT_FROZEN_HOLD_UNTIL: releaseFrozen,
            CREATORCUT_FROZEN_OWNER_TOKEN:
              "00000000-0000-4000-8000-000000000002",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      frozen = frozenProcess;
      const result = childResult(frozenProcess);
      await waitForPath(frozenEntered);
      releasePublish();
      await published;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      expect(currentEntered).toBe(false);

      await writeFile(releaseFrozen, "release", "utf8");
      const frozenResult = await result;
      expect(frozenResult.code, frozenResult.output).toBe(0);
      await waitForPath(join(state, "project.lock", ".creating"));
      const entryDeadline = Date.now() + 2_000;
      while (!currentEntered && Date.now() < entryDeadline) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      }
      expect(currentEntered).toBe(true);
      releaseCurrent();
      await current;
    } finally {
      publishCheckpoint.enabled = false;
      publishCheckpoint.pauseAfterPublish = false;
      releasePublish();
      releaseCurrent();
      await writeFile(releaseFrozen, "release", "utf8").catch(() => undefined);
      frozen?.kill("SIGTERM");
      await current.catch(() => undefined);
    }
  }, 10_000);

  it("keeps a late frozen contender out while the guard remains visible", async () => {
    const state = await fixture();
    const frozenEntered = join(state, "late-frozen-entered");
    const frozenOwnerToken = "00000000-0000-4000-8000-000000000003";
    const frozenPath = join(state, "project.lock", `${frozenOwnerToken}.json`);
    const script = fileURLToPath(
      new URL("./fixtures/legacy-v1-lock-contender.mjs", import.meta.url),
    );
    let signalPublished!: () => void;
    let releaseAfterPublish!: () => void;
    publishCheckpoint.enabled = true;
    publishCheckpoint.intercepted = false;
    publishCheckpoint.release = Promise.resolve();
    publishCheckpoint.pauseAfterPublish = true;
    publishCheckpoint.afterPublishRelease = new Promise<void>((resolve) => {
      releaseAfterPublish = resolve;
    });
    const published = new Promise<void>((resolve) => {
      signalPublished = resolve;
    });
    publishCheckpoint.reached = null;
    publishCheckpoint.published = signalPublished;

    let releaseCurrent!: () => void;
    const holdCurrent = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    let currentEntered = false;
    const current = withCreatorCutProjectLock(state, async () => {
      currentEntered = true;
      await holdCurrent;
    });
    let frozen: ReturnType<typeof spawn> | null = null;
    try {
      await published;
      const frozenProcess = spawn(
        process.execPath,
        [script, state, frozenEntered],
        {
          env: {
            ...process.env,
            CREATORCUT_FROZEN_FORCE_EQUAL_BIRTHTIME: "1",
            CREATORCUT_FROZEN_OWNER_TOKEN: frozenOwnerToken,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      frozen = frozenProcess;
      const result = childResult(frozenProcess);
      await waitForPath(frozenPath);

      expect(currentEntered).toBe(false);

      const frozenResult = await result;
      expect(frozenResult.code, frozenResult.output).toBe(0);
      await expect(access(frozenEntered)).rejects.toMatchObject({
        code: "ENOENT",
      });
      releaseAfterPublish();
      const entryDeadline = Date.now() + 2_000;
      while (!currentEntered && Date.now() < entryDeadline) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      }
      expect(currentEntered).toBe(true);
      releaseCurrent();
      await current;
    } finally {
      publishCheckpoint.enabled = false;
      publishCheckpoint.pauseAfterPublish = false;
      releaseAfterPublish();
      releaseCurrent();
      frozen?.kill("SIGTERM");
      await current.catch(() => undefined);
    }
  }, 10_000);

  it("fails closed while a late frozen-v1 contender stays continuously live", async () => {
    const state = await fixture();
    const frozenOwnerToken = "00000000-0000-4000-8000-000000000004";
    const frozenPath = join(state, "project.lock", `${frozenOwnerToken}.json`);
    let signalPublished!: () => void;
    let releaseAfterPublish!: () => void;
    publishCheckpoint.enabled = true;
    publishCheckpoint.intercepted = false;
    publishCheckpoint.release = Promise.resolve();
    publishCheckpoint.pauseAfterPublish = true;
    publishCheckpoint.afterPublishRelease = new Promise<void>((resolve) => {
      releaseAfterPublish = resolve;
    });
    const published = new Promise<void>((resolve) => {
      signalPublished = resolve;
    });
    publishCheckpoint.reached = null;
    publishCheckpoint.published = signalPublished;

    let currentEntered = false;
    const current = withCreatorCutProjectLock(state, async () => {
      currentEntered = true;
    });
    let frozenProcess: ReturnType<typeof spawn> | null = null;
    try {
      await published;
      frozenProcess = spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 5000)"],
        {
          stdio: ["ignore", "ignore", "ignore"],
        },
      );
      if (!frozenProcess.pid)
        throw new Error("Frozen fixture PID is unavailable");
      await writeFile(
        frozenPath,
        JSON.stringify({
          schema_version: "creatorcut-project-lock/1.0",
          pid: frozenProcess.pid,
          owner_token: frozenOwnerToken,
          created_at: new Date().toISOString(),
        }),
        "utf8",
      );
      releaseAfterPublish();

      await expect(current).rejects.toThrow(
        "locked by another local operation",
      );
      expect(currentEntered).toBe(false);
      await expect(access(frozenPath)).resolves.toBeUndefined();
    } finally {
      publishCheckpoint.enabled = false;
      publishCheckpoint.pauseAfterPublish = false;
      releaseAfterPublish();
      frozenProcess?.kill("SIGTERM");
      await rm(frozenPath, { force: true });
      await current.catch(() => undefined);
    }
  }, 10_000);
});
