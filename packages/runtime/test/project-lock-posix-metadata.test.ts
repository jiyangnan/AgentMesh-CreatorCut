import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const metadataState = vi.hoisted(() => ({
  violation: "mode" as "mode" | "uid" | "dev",
}));

const execFileMock = vi.hoisted(() =>
  vi.fn((...args: unknown[]) => {
    const callback = args.at(-1) as (
      error: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    callback(null, "Mon Aug 10 00:00:00 2026\n", "");
  }),
);

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: execFileMock,
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  platform: () => "darwin" as const,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    lstat: async (...args: any[]) => {
      const info = await (original.lstat as any)(...args);
      if (!String(args[0]).endsWith("current-mutex.sqlite")) return info;
      const changed = Object.assign(
        Object.create(Object.getPrototypeOf(info)),
        info,
      );
      if (metadataState.violation === "mode") changed.mode |= 0o040n;
      if (metadataState.violation === "uid") changed.uid += 1n;
      if (metadataState.violation === "dev") changed.dev += 1n;
      return changed;
    },
  };
});

import { withCreatorCutProjectLock } from "../src/project-lock.js";

describe("CreatorCut POSIX mutex metadata", () => {
  it("rejects unsafe mode, owner, and device metadata", async () => {
    for (const violation of ["mode", "uid", "dev"] as const) {
      metadataState.violation = violation;
      const root = await mkdtemp(
        join(tmpdir(), `creatorcut-posix-${violation}-`),
      );
      const state = join(root, ".creatorcut");
      await mkdir(state);
      await expect(
        withCreatorCutProjectLock(state, async () => "must-not-enter"),
      ).rejects.toThrow("current mutex path failed security checks");
    }
  });
});
