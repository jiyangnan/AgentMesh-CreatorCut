import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const verificationCheckpoint = vi.hoisted(() => ({
  enabled: false,
  failed: false,
  publishedPath: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const interceptedRename: typeof original.rename = async (...args: any[]) => {
    await (original.rename as any)(...args);
    const source = String(args[0]);
    const destination = String(args[1]);
    if (
      verificationCheckpoint.enabled &&
      /[\\/]\.creating[\\/]/u.test(source) &&
      destination.includes("00000000-0000-0000-0000-000000000000.") &&
      destination.endsWith(".json")
    ) {
      verificationCheckpoint.publishedPath = destination;
    }
  };
  const interceptedLstat: typeof original.lstat = async (...args: any[]) => {
    if (
      verificationCheckpoint.enabled &&
      !verificationCheckpoint.failed &&
      String(args[0]) === verificationCheckpoint.publishedPath
    ) {
      verificationCheckpoint.failed = true;
      throw Object.assign(new Error("Injected post-publish lstat failure"), {
        code: "EIO",
      });
    }
    return (original.lstat as any)(...args);
  };
  return {
    ...original,
    lstat: interceptedLstat,
    rename: interceptedRename,
  };
});

import { withCreatorCutProjectLock } from "../src/project-lock.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "creatorcut-post-publish-"));
  const state = join(root, ".creatorcut");
  await mkdir(state);
  return state;
}

describe("CreatorCut post-publish lock verification", () => {
  it("removes its published guard after post-rename verification fails", async () => {
    const state = await fixture();
    verificationCheckpoint.enabled = true;
    verificationCheckpoint.failed = false;
    verificationCheckpoint.publishedPath = "";
    let firstOperationCalls = 0;

    await expect(
      withCreatorCutProjectLock(state, async () => {
        firstOperationCalls += 1;
      }),
    ).rejects.toThrow("Injected post-publish lstat failure");
    expect(firstOperationCalls).toBe(0);

    const lockDirectory = join(state, "project.lock");
    expect(
      (await readdir(lockDirectory)).filter((name) => name.endsWith(".json")),
    ).toEqual([]);

    verificationCheckpoint.enabled = false;
    await expect(
      withCreatorCutProjectLock(state, async () => "recovered"),
    ).resolves.toBe("recovered");
    expect(await readdir(join(lockDirectory, ".creating"))).toEqual([
      "current-mutex.sqlite",
    ]);
  });
});
