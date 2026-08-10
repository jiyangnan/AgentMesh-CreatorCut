import { open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, it } from "vitest";

import { withCreatorCutProjectLock } from "../src/project-lock.js";

const state = process.env.CREATORCUT_LOCK_STATE;

describe.runIf(Boolean(state))("public lock process fixture", () => {
  it("holds the shared lock", async () => {
    const projectState = state!;
    await withCreatorCutProjectLock(projectState, async () => {
      if (process.env.CREATORCUT_LOCK_READY_FILE) {
        await writeFile(
          process.env.CREATORCUT_LOCK_READY_FILE,
          "public",
          "utf8",
        );
      }
      const sentinel = join(projectState, "..", "lock-active.sentinel");
      const handle = await open(sentinel, "wx", 0o600);
      console.log("LOCKED public");
      try {
        await new Promise((resolveDelay) =>
          setTimeout(
            resolveDelay,
            Number(process.env.CREATORCUT_LOCK_HOLD_MS ?? 100),
          ),
        );
      } finally {
        await handle.close();
        await rm(sentinel, { force: true });
        console.log("RELEASED public");
      }
    });
  });
});
