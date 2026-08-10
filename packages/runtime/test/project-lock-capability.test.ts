import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const linkMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  link: linkMock,
}));

import { withCreatorCutProjectLock } from "../src/project-lock.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "creatorcut-lock-capability-"));
  const state = join(root, ".creatorcut");
  await mkdir(state);
  return state;
}

describe("CreatorCut project lock filesystem capability", () => {
  beforeEach(() => {
    linkMock.mockRejectedValue(
      Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" }),
    );
  });

  it("does not require hard links and remains reusable when they are unsupported", async () => {
    const state = await fixture();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        withCreatorCutProjectLock(state, async () => "entered"),
      ).resolves.toBe("entered");
      expect(linkMock).not.toHaveBeenCalled();
      expect(await readdir(join(state, "project.lock"))).toEqual([".creating"]);
      expect(await readdir(join(state, "project.lock", ".creating"))).toEqual([
        "current-mutex.sqlite",
      ]);
    }
  });
});
