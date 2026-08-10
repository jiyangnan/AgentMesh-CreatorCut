import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createCreatorCutProject,
  openCreatorCutProject,
} from "../src/index.js";
import { withCreatorCutProjectLock } from "../src/project-lock.js";
import {
  migrateLegacyInternalProject,
  rollbackStorageAuthorityMigration,
  withPublicStorageMutation,
} from "../src/storage-authority.js";
import type { PublicMutationFailureStage } from "../src/types.js";
import {
  legacyFixture,
  project,
  timeline,
} from "./storage-authority-fixtures.js";

const internalRoot = process.env.CREATORCUT_INTERNAL_ROOT;
const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "creatorcut-lock-interop-"));
  const state = join(root, "project.creatorcut", ".creatorcut");
  await mkdir(state, { recursive: true });
  return state;
}

function vitestProcess(
  root: string,
  packageName: string,
  testFile: string,
  state: string,
  environment: Record<string, string> = {},
): {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<string>;
  completed: Promise<string>;
} {
  const readyFile = join(dirname(state), `lock-ready-${randomUUID()}`);
  const child = spawn(
    "pnpm",
    ["--filter", packageName, "exec", "vitest", "run", testFile],
    {
      cwd: root,
      env: {
        ...process.env,
        CREATORCUT_LOCK_STATE: state,
        CREATORCUT_LOCK_READY_FILE: readyFile,
        ...environment,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  const ready = new Promise<string>((resolveReady, rejectReady) => {
    const poll = setInterval(() => {
      void access(readyFile)
        .then(() => {
          clearInterval(poll);
          resolveReady(output);
        })
        .catch(() => undefined);
    }, 10);
    child.once("error", (error) => {
      clearInterval(poll);
      rejectReady(error);
    });
    child.once("exit", (code) => {
      if (code !== 0) {
        clearInterval(poll);
        rejectReady(new Error(`Lock fixture exited before ready: ${code}`));
      }
    });
  });
  const onData = (value: Buffer) => {
    output += value.toString("utf8");
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const completed = new Promise<string>((resolveCompleted, rejectCompleted) => {
    child.on("error", rejectCompleted);
    child.on("exit", (code) => {
      if (code === 0) resolveCompleted(output);
      else
        rejectCompleted(new Error(`Lock fixture exited ${code}:\n${output}`));
    });
  });
  return { child, ready, completed };
}

function oneShotVitestProcess(
  root: string,
  packageName: string,
  testFile: string,
  environment: Record<string, string>,
): Promise<string> {
  const child = spawn(
    "pnpm",
    ["--filter", packageName, "exec", "vitest", "run", testFile],
    {
      cwd: root,
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (value: Buffer) => {
    output += value.toString("utf8");
  });
  child.stderr.on("data", (value: Buffer) => {
    output += value.toString("utf8");
  });
  return new Promise<string>((resolveCompleted, rejectCompleted) => {
    child.on("error", rejectCompleted);
    child.on("exit", (code) => {
      if (code === 0) resolveCompleted(output);
      else
        rejectCompleted(
          new Error(`Operation fixture exited ${code}:\n${output}`),
        );
    });
  });
}

describe.runIf(Boolean(internalRoot))(
  "public/internal cross-process lock interop",
  () => {
    it("blocks public entry while the internal runtime owns the lock", async () => {
      const state = await fixture();
      const internal = vitestProcess(
        internalRoot!,
        "@creatorcut/project-store",
        "test/project-lock-process.test.ts",
        state,
        { CREATORCUT_LOCK_HOLD_MS: "3000" },
      );
      await internal.ready;
      let entered = false;
      await expect(
        withCreatorCutProjectLock(state, async () => {
          entered = true;
        }),
      ).rejects.toThrow("locked by another local operation");
      expect(entered).toBe(false);
      await expect(internal.completed).resolves.toBeDefined();
    }, 10_000);

    it("blocks internal entry while the public runtime owns the lock", async () => {
      const state = await fixture();
      await withCreatorCutProjectLock(state, async () => {
        const internal = vitestProcess(
          internalRoot!,
          "@creatorcut/project-store",
          "test/project-lock-process.test.ts",
          state,
          { CREATORCUT_LOCK_EXPECT_BLOCKED: "1" },
        );
        await expect(internal.completed).resolves.toBeDefined();
      });
    }, 10_000);

    it("blocks public create while internal owns the shared lock", async () => {
      const state = await fixture();
      const internal = vitestProcess(
        internalRoot!,
        "@creatorcut/project-store",
        "test/project-lock-process.test.ts",
        state,
        { CREATORCUT_LOCK_HOLD_MS: "3000" },
      );
      await internal.ready;
      await expect(
        createCreatorCutProject(dirname(state), {
          project: project(0),
          timeline: timeline(0),
        }),
      ).rejects.toThrow(/locked by another local operation/u);
      await expect(internal.completed).resolves.toBeDefined();
    }, 10_000);

    it("blocks internal create while public owns the shared lock", async () => {
      const state = await fixture();
      await withCreatorCutProjectLock(state, async () => {
        const internal = vitestProcess(
          internalRoot!,
          "@creatorcut/project-store",
          "test/project-lock-process.test.ts",
          state,
          { CREATORCUT_INTERNAL_CREATE_EXPECT_BLOCKED: "1" },
        );
        await expect(internal.completed).resolves.toBeDefined();
      });
    }, 10_000);

    it("blocks public authority migration while internal owns the shared lock", async () => {
      const value = await legacyFixture("migration-lock-interop");
      const state = join(value.projectDirectory, ".creatorcut");
      const internal = vitestProcess(
        internalRoot!,
        "@creatorcut/project-store",
        "test/project-lock-process.test.ts",
        state,
        { CREATORCUT_LOCK_HOLD_MS: "3000" },
      );
      await internal.ready;
      await expect(
        migrateLegacyInternalProject(value.projectDirectory, {
          backupDirectory: value.backupDirectory,
        }),
      ).rejects.toThrow(/locked by another local operation/u);
      await expect(internal.completed).resolves.toBeDefined();
    }, 10_000);

    for (const failureStage of [
      "after_mutation_body",
      "after_mutation_journal",
    ] satisfies PublicMutationFailureStage[]) {
      it(`recovers ${failureStage} before rollback and never revives public authority`, async () => {
        const root = await mkdtemp(
          join(tmpdir(), `creatorcut-rollback-interop-${failureStage}-`),
        );
        const projectDirectory = join(root, "project.creatorcut");
        const state = join(projectDirectory, ".creatorcut");
        await expect(
          oneShotVitestProcess(
            internalRoot!,
            "@creatorcut/project-store",
            "test/authority-write-process.test.ts",
            {
              CREATORCUT_INTERNAL_PROJECT: projectDirectory,
              CREATORCUT_INTERNAL_CREATE_FIXTURE: "1",
            },
          ),
        ).resolves.toBeDefined();
        const backupDirectory = join(root, "metadata-backup");
        await migrateLegacyInternalProject(projectDirectory, {
          backupDirectory,
        });
        await expect(
          withPublicStorageMutation(
            state,
            "rollback_interop",
            async (marker) => {
              await mkdir(join(state, "tasks"), { recursive: true });
              await writeFile(
                join(state, "tasks", "torn.json"),
                `${JSON.stringify({ private: "must-rollback" })}\n`,
              );
              return {
                value: undefined,
                currentRevision: marker.current_revision,
              };
            },
            { failureStage },
          ),
        ).rejects.toThrow(`Injected failure: ${failureStage}`);
        await rollbackStorageAuthorityMigration(
          projectDirectory,
          backupDirectory,
        );
        await expect(
          oneShotVitestProcess(
            internalRoot!,
            "@creatorcut/project-store",
            "test/authority-write-process.test.ts",
            { CREATORCUT_INTERNAL_PROJECT: projectDirectory },
          ),
        ).resolves.toBeDefined();
        const headPath = join(state, "head.json");
        const afterInternalWrite = await readFile(headPath);
        await expect(openCreatorCutProject(projectDirectory)).rejects.toThrow(
          /legacy internal storage|internal-project-store/u,
        );
        expect(await readFile(headPath)).toEqual(afterInternalWrite);
      }, 20_000);
    }

    it("respects a live legacy internal lock", async () => {
      const state = await fixture();
      const lockPath = join(state, "project.lock");
      const legacy = spawn(
        process.execPath,
        [
          "-e",
          "const fs=require('node:fs');const p=process.argv[1];fs.writeFileSync(p,JSON.stringify({pid:process.pid,created_at:new Date().toISOString()}));console.log('LOCKED legacy');process.on('SIGTERM',()=>{fs.rmSync(p,{force:true});process.exit(0)});setTimeout(()=>{},20000)",
          lockPath,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      await new Promise<void>((resolveReady, rejectReady) => {
        legacy.on("error", rejectReady);
        legacy.stdout.on("data", (value: Buffer) => {
          if (value.toString("utf8").includes("LOCKED legacy")) resolveReady();
        });
      });
      let entered = false;
      await expect(
        withCreatorCutProjectLock(state, async () => {
          entered = true;
        }),
      ).rejects.toThrow("locked by another local operation");
      expect(entered).toBe(false);
      legacy.kill("SIGTERM");
      await new Promise<void>((resolveExit, rejectExit) => {
        legacy.on("error", rejectExit);
        legacy.on("exit", (code) =>
          code === 0
            ? resolveExit()
            : rejectExit(new Error(`legacy exit ${code}`)),
        );
      });
    }, 10_000);

    it.each([
      { writeDelayMs: 400, attemptDelayMs: 0 },
      { writeDelayMs: 1_200, attemptDelayMs: 0 },
      { writeDelayMs: 6_000, attemptDelayMs: 5_200 },
    ])(
      "does not unlink a live legacy lock that writes after $writeDelayMs ms when contention starts after $attemptDelayMs ms",
      async ({ writeDelayMs, attemptDelayMs }) => {
        const state = await fixture();
        const lockPath = join(state, "project.lock");
        const legacy = spawn(
          process.execPath,
          [
            "-e",
            "const fs=require('node:fs');const p=process.argv[1];const delay=Number(process.argv[2]);const fd=fs.openSync(p,'wx');console.log('OPENED legacy');setTimeout(()=>{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,created_at:new Date().toISOString()}));fs.fsyncSync(fd);fs.closeSync(fd);console.log('WRITTEN legacy')},delay);process.on('SIGTERM',()=>{try{fs.closeSync(fd)}catch{}fs.rmSync(p,{force:true});process.exit(0)});setTimeout(()=>{},20000)",
            lockPath,
            String(writeDelayMs),
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        const written = new Promise<void>((resolveWritten, rejectWritten) => {
          legacy.on("error", rejectWritten);
          legacy.stdout.on("data", (value: Buffer) => {
            if (value.toString("utf8").includes("WRITTEN legacy")) {
              resolveWritten();
            }
          });
        });
        await new Promise<void>((resolveReady, rejectReady) => {
          legacy.on("error", rejectReady);
          legacy.stdout.on("data", (value: Buffer) => {
            if (value.toString("utf8").includes("OPENED legacy"))
              resolveReady();
          });
        });
        if (attemptDelayMs > 0) {
          await new Promise((resolveDelay) =>
            setTimeout(resolveDelay, attemptDelayMs),
          );
        }
        let entered = false;
        await expect(
          withCreatorCutProjectLock(state, async () => {
            entered = true;
          }),
        ).rejects.toThrow("locked by another local operation");
        expect(entered).toBe(false);
        await written;
        expect(await readFile(lockPath, "utf8")).toContain(
          `"pid":${legacy.pid}`,
        );
        legacy.kill("SIGTERM");
        await new Promise<void>((resolveExit, rejectExit) => {
          legacy.on("error", rejectExit);
          legacy.on("exit", (code) =>
            code === 0
              ? resolveExit()
              : rejectExit(new Error(`legacy exit ${code}`)),
          );
        });
      },
      15_000,
    );

    it("upgrades a stale legacy lock while mixed runtimes remain mutually exclusive", async () => {
      const state = await fixture();
      await writeFile(
        join(state, "project.lock"),
        JSON.stringify({
          pid: 2_147_483_647,
          created_at: "2026-08-09T00:00:00.000Z",
        }),
        "utf8",
      );
      const internal = vitestProcess(
        internalRoot!,
        "@creatorcut/project-store",
        "test/project-lock-process.test.ts",
        state,
        { CREATORCUT_LOCK_HOLD_MS: "100" },
      );
      const publicProcess = vitestProcess(
        publicRoot,
        "@agentmesh/creatorcut-runtime",
        "test/project-lock-process.test.ts",
        state,
        { CREATORCUT_LOCK_HOLD_MS: "100" },
      );
      await Promise.all([internal.completed, publicProcess.completed]);
    }, 10_000);
  },
);
