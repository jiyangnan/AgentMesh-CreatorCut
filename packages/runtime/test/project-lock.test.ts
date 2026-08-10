import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { withCreatorCutProjectLock } from "../src/project-lock.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "creatorcut-lock-"));
  const state = join(root, ".creatorcut");
  await mkdir(state);
  return state;
}

describe("CreatorCut shared project lock", () => {
  it("keeps the v1 wire body readable to a frozen old reader", async () => {
    const state = await fixture();
    const enteredPath = join(state, "legacy-reader-entered");
    const script = fileURLToPath(
      new URL("./fixtures/legacy-v1-lock-contender.mjs", import.meta.url),
    );
    await withCreatorCutProjectLock(state, async () => {
      const lockDirectory = join(state, "project.lock");
      const newContender = (await readdir(lockDirectory)).find((name) =>
        name.endsWith(".json"),
      );
      expect(newContender).toMatch(
        /^00000000-0000-0000-0000-000000000000\.[0-9a-f-]{36}(?:\.[a-f0-9]{64})?\.json$/u,
      );
      const wire = JSON.parse(
        await readFile(join(lockDirectory, newContender!), "utf8"),
      );
      expect(Object.keys(wire).sort()).toEqual([
        "created_at",
        "owner_token",
        "pid",
        "schema_version",
      ]);

      const child = spawn(process.execPath, [script, state, enteredPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const result = await new Promise<{ code: number | null; output: string }>(
        (resolveChild, rejectChild) => {
          let output = "";
          child.stdout.on("data", (value: Buffer) => {
            output += value.toString("utf8");
          });
          child.stderr.on("data", (value: Buffer) => {
            output += value.toString("utf8");
          });
          child.on("error", rejectChild);
          child.on("close", (code) => resolveChild({ code, output }));
        },
      );
      expect(result, result.output).toMatchObject({ code: 0 });
      await expect(access(enteredPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        access(join(lockDirectory, newContender!)),
      ).resolves.toBeUndefined();
    });
  });

  it("keeps a current guard ahead of a raw frozen-v1 UUID when birthtimes tie", async () => {
    const state = await fixture();
    const enteredPath = join(state, "equal-birthtime-frozen-entered");
    const script = fileURLToPath(
      new URL("./fixtures/legacy-v1-lock-contender.mjs", import.meta.url),
    );
    await withCreatorCutProjectLock(state, async () => {
      const lockDirectory = join(state, "project.lock");
      const guard = (await readdir(lockDirectory)).find((name) =>
        name.startsWith("00000000-0000-0000-0000-000000000000."),
      );
      expect(guard).toBeDefined();

      const child = spawn(process.execPath, [script, state, enteredPath], {
        env: {
          ...process.env,
          CREATORCUT_FROZEN_FORCE_EQUAL_BIRTHTIME: "1",
          CREATORCUT_FROZEN_OWNER_TOKEN: "00000000-0000-4000-8000-000000000001",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const result = await new Promise<{ code: number | null; output: string }>(
        (resolveChild, rejectChild) => {
          let output = "";
          child.stdout.on("data", (value: Buffer) => {
            output += value.toString("utf8");
          });
          child.stderr.on("data", (value: Buffer) => {
            output += value.toString("utf8");
          });
          child.on("error", rejectChild);
          child.on("close", (code) => resolveChild({ code, output }));
        },
      );
      expect(result, result.output).toMatchObject({ code: 0 });
      await expect(access(enteredPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("keeps contender staging invisible to a frozen v1 reader", async () => {
    const state = await fixture();
    const lockDirectory = join(state, "project.lock");
    const creatingDirectory = join(lockDirectory, ".creating");
    const partial = join(creatingDirectory, ".creating-partial.tmp");
    const enteredPath = join(state, "legacy-reader-entered");
    const script = fileURLToPath(
      new URL("./fixtures/legacy-v1-lock-contender.mjs", import.meta.url),
    );
    await mkdir(creatingDirectory, { recursive: true });
    await writeFile(partial, "{");

    const child = spawn(process.execPath, [script, state, enteredPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = await new Promise<{ code: number | null; output: string }>(
      (resolveChild, rejectChild) => {
        let output = "";
        child.stdout.on("data", (value: Buffer) => {
          output += value.toString("utf8");
        });
        child.stderr.on("data", (value: Buffer) => {
          output += value.toString("utf8");
        });
        child.on("error", rejectChild);
        child.on("close", (code) => resolveChild({ code, output }));
      },
    );
    expect(result, result.output).toMatchObject({ code: 2 });
    await expect(access(enteredPath)).resolves.toBeUndefined();
    await expect(readFile(partial, "utf8")).resolves.toBe("{");
  });

  it("closes acquired handles and removes only its owned lock", async () => {
    const state = await fixture();
    const before = await readdir("/dev/fd").catch(() => []);
    for (let index = 0; index < 50; index += 1) {
      await withCreatorCutProjectLock(state, async () => index);
    }
    const after = await readdir("/dev/fd").catch(() => []);
    if (before.length > 0 && after.length > 0) {
      expect(after.length).toBeLessThanOrEqual(before.length + 2);
    }
    expect(await readdir(join(state, "project.lock"))).toEqual([".creating"]);
    expect(await readdir(join(state, "project.lock", ".creating"))).toEqual([
      "current-mutex.sqlite",
    ]);
  });

  it("rejects a nonempty preexisting SQLite mutex without changing it", async () => {
    const state = await fixture();
    const creating = join(state, "project.lock", ".creating");
    const mutex = join(creating, "current-mutex.sqlite");
    const bytes = Buffer.from("SQLite format 3\0untrusted");
    await mkdir(creating, { recursive: true, mode: 0o700 });
    await writeFile(mutex, bytes, { mode: 0o600 });

    await expect(
      withCreatorCutProjectLock(state, async () => "must-not-enter"),
    ).rejects.toThrow("current mutex path failed security checks");
    await expect(readFile(mutex)).resolves.toEqual(bytes);
  });

  it("keeps the SQLite mutex empty and sidecar-free while held", async () => {
    const state = await fixture();
    const creating = join(state, "project.lock", ".creating");
    const mutex = join(creating, "current-mutex.sqlite");

    await withCreatorCutProjectLock(state, async () => {
      expect(await readdir(creating)).toEqual(["current-mutex.sqlite"]);
      expect((await stat(mutex)).size).toBe(0);
    });

    expect(await readdir(creating)).toEqual(["current-mutex.sqlite"]);
    expect((await stat(mutex)).size).toBe(0);
  });

  it("rejects every preexisting SQLite sidecar without changing it", async () => {
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      const state = await fixture();
      const creating = join(state, "project.lock", ".creating");
      const mutex = join(creating, "current-mutex.sqlite");
      const sidecar = `${mutex}${suffix}`;
      await mkdir(creating, { recursive: true, mode: 0o700 });
      await writeFile(mutex, "", { mode: 0o600 });
      await writeFile(sidecar, `retain-${suffix}`, { mode: 0o600 });

      await expect(
        withCreatorCutProjectLock(state, async () => "must-not-enter"),
      ).rejects.toThrow("current mutex path failed security checks");
      await expect(readFile(sidecar, "utf8")).resolves.toBe(`retain-${suffix}`);
    }
  });

  it.runIf(platform() !== "win32")(
    "rejects a symlinked SQLite sidecar without touching its target",
    async () => {
      const state = await fixture();
      const creating = join(state, "project.lock", ".creating");
      const mutex = join(creating, "current-mutex.sqlite");
      const outside = await mkdtemp(
        join(tmpdir(), "creatorcut-mutex-sidecar-external-"),
      );
      const sentinel = join(outside, "sentinel.bin");
      await mkdir(creating, { recursive: true, mode: 0o700 });
      await writeFile(mutex, "", { mode: 0o600 });
      await writeFile(sentinel, "keep-me", { mode: 0o600 });
      await symlink(sentinel, `${mutex}-journal`);

      await expect(
        withCreatorCutProjectLock(state, async () => "must-not-enter"),
      ).rejects.toThrow("current mutex path failed security checks");
      await expect(readFile(sentinel, "utf8")).resolves.toBe("keep-me");
    },
  );

  it("serializes current processes and recovers after the holder is terminated", async () => {
    const state = await fixture();
    const script = fileURLToPath(
      new URL("./fixtures/current-lock-contender.mjs", import.meta.url),
    );
    const firstAttempted = join(state, "first-current-attempted");
    const firstReady = join(state, "first-current-ready");
    const secondAttempted = join(state, "second-current-attempted");
    const secondReady = join(state, "second-current-ready");
    const secondRelease = join(state, "release-second-current");
    const thirdAttempted = join(state, "third-current-attempted");
    const thirdReady = join(state, "third-current-ready");
    const thirdRelease = join(state, "release-third-current");
    const childExit = (child: ReturnType<typeof spawn>) =>
      new Promise<{
        code: number | null;
        output: string;
        signal: NodeJS.Signals | null;
      }>((resolveExit, rejectExit) => {
        let output = "";
        child.stdout?.on("data", (value: Buffer) => {
          output += value.toString("utf8");
        });
        child.stderr?.on("data", (value: Buffer) => {
          output += value.toString("utf8");
        });
        child.on("error", rejectExit);
        child.on("close", (code, signal) =>
          resolveExit({ code, output, signal }),
        );
      });
    const waitForPath = async (path: string) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (
          await access(path)
            .then(() => true)
            .catch(() => false)
        )
          return;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      throw new Error(`Timed out waiting for ${path}`);
    };
    const first = spawn(
      process.execPath,
      [script, state, firstAttempted, firstReady, "-"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const firstExit = childExit(first);
    let second: ReturnType<typeof spawn> | null = null;
    let secondExit: ReturnType<typeof childExit> | null = null;
    let third: ReturnType<typeof spawn> | null = null;
    let thirdExit: ReturnType<typeof childExit> | null = null;
    try {
      await waitForPath(firstAttempted);
      await waitForPath(firstReady);
      await writeFile(secondRelease, "release", "utf8");
      second = spawn(
        process.execPath,
        [script, state, secondAttempted, secondReady, secondRelease],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      secondExit = childExit(second);
      await waitForPath(secondAttempted);
      const blocked = await secondExit;
      expect(blocked, blocked.output).toMatchObject({ code: 1, signal: null });
      expect(blocked.output).toContain(
        "CreatorCut project is locked by another local operation",
      );
      await expect(access(secondReady)).rejects.toMatchObject({
        code: "ENOENT",
      });

      first.kill("SIGKILL");
      const killed = await firstExit;
      expect(killed).toMatchObject({ code: null, signal: "SIGKILL" });

      await writeFile(thirdRelease, "release", "utf8");
      third = spawn(
        process.execPath,
        [script, state, thirdAttempted, thirdReady, thirdRelease],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      thirdExit = childExit(third);
      await waitForPath(thirdAttempted);
      await waitForPath(thirdReady);
      const recoveredChild = await thirdExit;
      expect(recoveredChild, recoveredChild.output).toMatchObject({
        code: 0,
        signal: null,
      });
      await expect(
        withCreatorCutProjectLock(state, async () => "recovered"),
      ).resolves.toBe("recovered");
      expect(await readdir(join(state, "project.lock", ".creating"))).toEqual([
        "current-mutex.sqlite",
      ]);
    } finally {
      first.kill("SIGKILL");
      second?.kill("SIGKILL");
      third?.kill("SIGKILL");
      await writeFile(secondRelease, "release", "utf8").catch(() => undefined);
      await writeFile(thirdRelease, "release", "utf8").catch(() => undefined);
      await Promise.allSettled([
        firstExit,
        ...(secondExit ? [secondExit] : []),
        ...(thirdExit ? [thirdExit] : []),
      ]);
    }
  }, 15_000);

  it("does not reinterpret a business EEXIST error as lock contention", async () => {
    const state = await fixture();
    let calls = 0;
    const failure = Object.assign(new Error("business collision"), {
      code: "EEXIST",
    });
    await expect(
      withCreatorCutProjectLock(state, async () => {
        calls += 1;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  it("serializes two same-process operations without relying on process-wide SQLite locks", async () => {
    const state = await fixture();
    let firstCalls = 0;
    let secondCalls = 0;
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withCreatorCutProjectLock(state, async () => {
      firstCalls += 1;
      await gate;
      return "first";
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = withCreatorCutProjectLock(state, async () => {
      secondCalls += 1;
      return "second";
    });
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "second",
    ]);
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
  });

  it("releases the lock when the operation throws", async () => {
    const state = await fixture();
    await expect(
      withCreatorCutProjectLock(state, async () => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");
    await expect(
      withCreatorCutProjectLock(state, async () => "recovered"),
    ).resolves.toBe("recovered");
  });

  it.each(["", "{truncated"])(
    "fails closed for an unidentified legacy lock containing %j",
    async (contents) => {
      const state = await fixture();
      const lockPath = join(state, "project.lock");
      await writeFile(lockPath, contents, "utf8");
      await expect(
        withCreatorCutProjectLock(state, async () => "must-not-enter"),
      ).rejects.toThrow("locked by another local operation");
      expect(await readFile(lockPath, "utf8")).toBe(contents);
    },
  );

  it("does not unlink a replacement owner while multiple waiters clean dead owners", async () => {
    const state = await fixture();
    const lockDirectory = join(state, "project.lock");
    await mkdir(lockDirectory);
    for (const token of ["dead-a", "dead-b"]) {
      await writeFile(
        join(lockDirectory, `${token}.json`),
        JSON.stringify({
          schema_version: "creatorcut-project-lock/1.0",
          pid: 2_147_483_647,
          owner_token: token,
          created_at: "2026-08-09T00:00:00.000Z",
        }),
      );
    }
    await writeFile(
      join(lockDirectory, "active.json"),
      JSON.stringify({
        schema_version: "creatorcut-project-lock/1.0",
        pid: 2_147_483_647,
        owner_token: "retired-fixed-active",
        created_at: "2026-08-09T00:00:00.000Z",
      }),
    );
    let active = 0;
    let maximumActive = 0;
    const run = () =>
      withCreatorCutProjectLock(state, async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        active -= 1;
      });
    await Promise.all([run(), run(), run()]);
    expect(maximumActive).toBe(1);
    expect(await readdir(lockDirectory)).toEqual([".creating"]);
    expect(await readdir(join(lockDirectory, ".creating"))).toEqual([
      "current-mutex.sqlite",
    ]);
  });

  it.each([0, -1])(
    "never treats invalid pid %s as a live owner",
    async (pid) => {
      const state = await fixture();
      await writeFile(
        join(state, "project.lock"),
        JSON.stringify({ pid, created_at: "2026-08-09T00:00:00.000Z" }),
        "utf8",
      );
      await expect(
        withCreatorCutProjectLock(state, async () => "recovered"),
      ).resolves.toBe("recovered");
    },
  );

  it("rejects a reused PID whose process start identity does not match", async () => {
    const probeState = await fixture();
    let identityAvailable = false;
    await withCreatorCutProjectLock(probeState, async () => {
      const name = (await readdir(join(probeState, "project.lock"))).find(
        (value) => value !== "active.json" && value.endsWith(".json"),
      );
      identityAvailable = /\.[a-f0-9]{64}\.json$/u.test(name ?? "");
    });
    const state = await fixture();
    const lockDirectory = join(state, "project.lock");
    await mkdir(lockDirectory);
    await writeFile(
      join(lockDirectory, `reused.${"0".repeat(64)}.json`),
      JSON.stringify({
        schema_version: "creatorcut-project-lock/1.0",
        pid: process.pid,
        owner_token: "reused",
        created_at: new Date().toISOString(),
      }),
      "utf8",
    );
    const attempt = withCreatorCutProjectLock(state, async () => "recovered");
    if (identityAvailable) {
      await expect(attempt).resolves.toBe("recovered");
    } else {
      await expect(attempt).rejects.toThrow(
        "locked by another local operation",
      );
    }
  });

  it.each(["", "{truncated"])(
    "fails closed for an unidentified recovery-gate contender containing %j",
    async (contents) => {
      const state = await fixture();
      const lockPath = join(state, "project.lock");
      await writeFile(lockPath, "{stale", "utf8");
      const recovery = join(state, "project.lock.recovery");
      await mkdir(recovery);
      const orphan = join(recovery, "orphan.json");
      await writeFile(orphan, contents, "utf8");
      await expect(
        withCreatorCutProjectLock(state, async () => "must-not-enter"),
      ).rejects.toThrow("locked by another local operation");
      expect(await readFile(orphan, "utf8")).toBe(contents);
    },
  );

  it("does not bypass a live recovery-gate contender", async () => {
    const state = await fixture();
    await writeFile(join(state, "project.lock"), "{stale", "utf8");
    const recovery = join(state, "project.lock.recovery");
    await mkdir(recovery);
    await writeFile(
      join(recovery, "live.json"),
      JSON.stringify({
        schema_version: "creatorcut-project-lock/1.0",
        pid: 1,
        owner_token: "live",
        created_at: "2026-08-09T00:00:00.000Z",
      }),
      "utf8",
    );
    await expect(
      withCreatorCutProjectLock(state, async () => "must-not-enter"),
    ).rejects.toThrow("locked by another local operation");
  });

  it("fails closed for a recent unidentified legacy writer window", async () => {
    const state = await fixture();
    await writeFile(join(state, "project.lock"), "", "utf8");
    await expect(
      withCreatorCutProjectLock(state, async () => "must-not-enter"),
    ).rejects.toThrow("locked by another local operation");
  });

  it("never expires a live PID-only owner without a recorded process identity", async () => {
    const state = await fixture();
    const lockDirectory = join(state, "project.lock");
    const liveProcess = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)"],
      { stdio: "ignore" },
    );
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      liveProcess.once("spawn", resolveSpawn);
      liveProcess.once("error", rejectSpawn);
    });
    if (!liveProcess.pid) throw new Error("Live fixture PID is unavailable");
    try {
      await mkdir(lockDirectory);
      const fresh = join(lockDirectory, "fresh.json");
      await writeFile(
        fresh,
        JSON.stringify({
          schema_version: "creatorcut-project-lock/1.0",
          pid: liveProcess.pid,
          owner_token: "fresh",
          created_at: new Date().toISOString(),
        }),
      );
      await expect(
        withCreatorCutProjectLock(state, async () => "must-not-enter"),
      ).rejects.toThrow("locked by another local operation");
      await rm(fresh);
      const oldLive = join(lockDirectory, "old-live.json");
      await writeFile(
        oldLive,
        JSON.stringify({
          schema_version: "creatorcut-project-lock/1.0",
          pid: liveProcess.pid,
          owner_token: "old-live",
          created_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        }),
      );
      await expect(
        withCreatorCutProjectLock(state, async () => "must-not-enter"),
      ).rejects.toThrow("locked by another local operation");
      await rm(oldLive);
      await writeFile(
        join(lockDirectory, "dead.json"),
        JSON.stringify({
          schema_version: "creatorcut-project-lock/1.0",
          pid: 2_147_483_647,
          owner_token: "dead",
          created_at: new Date().toISOString(),
        }),
      );
      await expect(
        withCreatorCutProjectLock(state, async () => "recovered"),
      ).resolves.toBe("recovered");
    } finally {
      const closed = new Promise<void>((resolveClose) => {
        liveProcess.once("close", () => resolveClose());
      });
      if (liveProcess.exitCode === null) liveProcess.kill("SIGTERM");
      if (liveProcess.exitCode === null) await closed;
    }
  }, 10_000);

  it("serializes multiple recovery cleaners and the replacement owner", async () => {
    const state = await fixture();
    await writeFile(
      join(state, "project.lock"),
      JSON.stringify({
        pid: 2_147_483_647,
        created_at: "2026-08-09T00:00:00.000Z",
      }),
      "utf8",
    );
    let active = 0;
    let maximumActive = 0;
    const run = () =>
      withCreatorCutProjectLock(state, async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        active -= 1;
      });
    await Promise.all([run(), run(), run()]);
    expect(maximumActive).toBe(1);
  });

  it.each(["project.lock", "project.lock.recovery"])(
    "rejects a %s symlink without touching its external target",
    async (name) => {
      const state = await fixture();
      const external = await mkdtemp(
        join(tmpdir(), "creatorcut-lock-external-"),
      );
      const sentinel = join(external, "sentinel.txt");
      await writeFile(sentinel, "keep-me", "utf8");
      if (name === "project.lock.recovery") {
        await writeFile(join(state, "project.lock"), "{stale", "utf8");
      }
      await symlink(external, join(state, name));
      await expect(
        withCreatorCutProjectLock(state, async () => "must-not-enter"),
      ).rejects.toThrow(/symbolic link|local directory/u);
      expect(await readFile(sentinel, "utf8")).toBe("keep-me");
      expect(await readdir(external)).toEqual(["sentinel.txt"]);
    },
  );

  it("rejects a symlinked contender staging directory without touching its target", async () => {
    const state = await fixture();
    const lockDirectory = join(state, "project.lock");
    const external = await mkdtemp(
      join(tmpdir(), "creatorcut-lock-staging-external-"),
    );
    const sentinel = join(external, "sentinel.txt");
    await Promise.all([
      mkdir(lockDirectory),
      writeFile(sentinel, "keep-me", "utf8"),
    ]);
    await symlink(external, join(lockDirectory, ".creating"));

    await expect(
      withCreatorCutProjectLock(state, async () => "must-not-enter"),
    ).rejects.toThrow(/staging directory must be local/u);
    expect(await readFile(sentinel, "utf8")).toBe("keep-me");
    expect(await readdir(external)).toEqual(["sentinel.txt"]);
  });
});
