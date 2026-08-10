import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const chmodMock = vi.hoisted(() =>
  vi.fn(async () => {
    throw Object.assign(new Error("synthetic fchmod failure"), {
      code: "EPERM",
    });
  }),
);
const closeMock = vi.hoisted(() => vi.fn());

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  platform: () => "darwin" as const,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...args: any[]) => {
      const handle = await (original.open as any)(...args);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "chmod") return chmodMock;
          const value = Reflect.get(target, property, target);
          if (property === "close") {
            return async (...closeArgs: unknown[]) => {
              closeMock();
              return (value as (...args: unknown[]) => Promise<void>).apply(
                target,
                closeArgs,
              );
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

import { preparePrivateWorkDirectory } from "../src/private-work.js";

describe("CreatorCut POSIX private-work mode handling", () => {
  it.runIf(process.platform !== "win32")(
    "propagates an inode chmod failure instead of weakening privacy",
    async () => {
      const project = await mkdtemp(
        join(tmpdir(), "creatorcut-private-posix-"),
      );

      await expect(
        preparePrivateWorkDirectory(project, ["previews"]),
      ).rejects.toMatchObject({ code: "EPERM" });
      expect(chmodMock).toHaveBeenCalledTimes(1);
      expect(closeMock).toHaveBeenCalledTimes(1);
    },
  );
});
