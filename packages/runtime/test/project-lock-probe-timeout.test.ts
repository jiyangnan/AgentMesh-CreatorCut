import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() =>
  vi.fn((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error) => void;
    setTimeout(
      () =>
        callback(
          Object.assign(new Error("identity probe timed out"), {
            code: "ETIMEDOUT",
          }),
        ),
      5,
    );
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

import { withCreatorCutProjectLock } from "../src/project-lock.js";

const children: ReturnType<typeof spawn>[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  execFileMock.mockClear();
});

describe("CreatorCut project lock identity probes", () => {
  it("bounds and reuses a failed external process identity probe", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "setTimeout(() => {}, 30000)",
    ]);
    children.push(child);
    const root = await mkdtemp(join(tmpdir(), "creatorcut-lock-probe-"));
    const state = join(root, ".creatorcut");
    const lockDirectory = join(state, "project.lock");
    await mkdir(lockDirectory, { recursive: true });
    const ownerToken = "external-owner";
    const digest = "f".repeat(64);
    const contender = `${ownerToken}.${digest}.json`;
    await writeFile(
      join(lockDirectory, contender),
      JSON.stringify({
        schema_version: "creatorcut-project-lock/1.0",
        pid: child.pid,
        owner_token: ownerToken,
        created_at: new Date().toISOString(),
      }),
    );

    const startedAt = Date.now();
    await expect(
      withCreatorCutProjectLock(state, async () => "must-not-enter"),
    ).rejects.toThrow("locked by another local operation");
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    for (const call of execFileMock.mock.calls) {
      expect(call.at(-2)).toMatchObject({ timeout: 250 });
    }
    expect((await readdir(lockDirectory)).sort()).toEqual([
      ".creating",
      contender,
    ]);
  });
});
