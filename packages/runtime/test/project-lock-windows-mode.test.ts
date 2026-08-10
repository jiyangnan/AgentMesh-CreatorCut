import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() =>
  vi.fn((...args: unknown[]) => {
    const callback = args.at(-1) as (
      error: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    callback(null, "638904456000000000\n", "");
  }),
);

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: execFileMock,
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  platform: () => "win32" as const,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    lstat: async (...args: any[]) => {
      const info = await (original.lstat as any)(...args);
      if (!String(args[0]).endsWith("current-mutex.sqlite")) return info;
      const windowsInfo = Object.assign(
        Object.create(Object.getPrototypeOf(info)),
        info,
      );
      windowsInfo.mode |= 0o066n;
      return windowsInfo;
    },
  };
});

import { withCreatorCutProjectLock } from "../src/project-lock.js";

describe("CreatorCut Windows project lock mode handling", () => {
  it("does not interpret synthetic POSIX group bits as Windows ACLs", async () => {
    const root = await mkdtemp(join(tmpdir(), "creatorcut-windows-mode-"));
    const state = join(root, ".creatorcut");
    await mkdir(state);

    await expect(
      withCreatorCutProjectLock(state, async () => "entered"),
    ).resolves.toBe("entered");
    expect(execFileMock).toHaveBeenCalled();
    expect(await readdir(join(state, "project.lock", ".creating"))).toEqual([
      "current-mutex.sqlite",
    ]);
  });
});
