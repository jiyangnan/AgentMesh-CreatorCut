import { link, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const chmodMock = vi.hoisted(() =>
  vi.fn(async () => {
    throw Object.assign(new Error("Windows fchmod must not be called"), {
      code: "EPERM",
    });
  }),
);

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  platform: () => "win32" as const,
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
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

import {
  finalizePrivateWorkFile,
  preparePrivateWorkDirectory,
  privateWorkPath,
  releasePrivateWorkDirectory,
} from "../src/private-work.js";

describe("CreatorCut Windows private-work mode handling", () => {
  it("inherits the project ACL without interpreting POSIX modes as a DACL", async () => {
    const project = await mkdtemp(join(tmpdir(), "creatorcut-private-win-"));
    const lease = await preparePrivateWorkDirectory(project, ["previews"]);
    try {
      const output = privateWorkPath(lease, "preview.mp4");
      await writeFile(output, "preview");
      await finalizePrivateWorkFile(lease, output);

      expect(chmodMock).not.toHaveBeenCalled();
    } finally {
      await releasePrivateWorkDirectory(lease);
    }
  });

  it("rejects a hard-linked output without changing the outside inode", async () => {
    const project = await mkdtemp(join(tmpdir(), "creatorcut-private-link-"));
    const outside = join(project, "outside.bin");
    await writeFile(outside, "sentinel", { mode: 0o644 });
    const lease = await preparePrivateWorkDirectory(project, ["previews"]);
    try {
      const output = privateWorkPath(lease, "preview.mp4");
      await link(outside, output);

      await expect(finalizePrivateWorkFile(lease, output)).rejects.toThrow(
        "private work file identity changed",
      );
      await expect(readFile(outside, "utf8")).resolves.toBe("sentinel");
      expect(chmodMock).not.toHaveBeenCalled();
    } finally {
      await releasePrivateWorkDirectory(lease);
    }
  });
});
