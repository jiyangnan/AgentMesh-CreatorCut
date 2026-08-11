import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { MemoryCredentialStore } from "@agentmesh/creatorcut-credentials";
import type { CloudDirectorAdapter } from "@agentmesh/creatorcut-director-client";
import { runExportTask } from "@agentmesh/creatorcut-media-engine";
import {
  commitLocalRevision,
  createCreatorCutProject,
  openCreatorCutProject,
  writeLocalArtifact,
} from "@agentmesh/creatorcut-runtime";
import * as publicRuntime from "@agentmesh/creatorcut-runtime";

import { executeCli } from "../src/index.js";
import {
  OPENCLAW_REQUEST_ENVIRONMENT,
  withNextProcess,
} from "../src/next-process.js";
import {
  migratedHandoffFixture,
  migratedNoVisualFixture,
} from "./handoff-fixture.js";

async function projectFixture(initialRevision = 1): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "creatorcut-cli-"));
  await createCreatorCutProject(root, {
    project: {
      schema_version: "1.0-alpha",
      project_id: "project-cli-1",
      name: "CLI fixture",
      revision: initialRevision,
      assets: [
        {
          asset_id: "asset-1",
          kind: "video",
          relative_path: "source.mov",
          sha256: "b".repeat(64),
          duration_us: 2_000_000,
          width: 1080,
          height: 1920,
          has_video: true,
          has_audio: true,
        },
      ],
    },
    timeline: {
      schema_version: "1.0-alpha",
      timeline_id: "timeline-1",
      project_id: "project-cli-1",
      revision: initialRevision,
      duration_us: 2_000_000,
      canvas: { width: 1080, height: 1920 },
      tracks: [
        {
          track_id: "video",
          kind: "video",
          clips: [
            {
              clip_id: "clip",
              asset_id: "asset-1",
              source_start_us: 0,
              source_end_us: 2_000_000,
              timeline_start_us: 0,
              timeline_end_us: 2_000_000,
            },
          ],
        },
      ],
    },
    transcript: {
      schema_version: "1.0-alpha",
      transcript_id: "transcript-1",
      project_id: "project-cli-1",
      revision: initialRevision,
      language_mode: "zh",
      segments: [
        {
          segment_id: "segment-1",
          source_asset_id: "asset-1",
          start_us: 0,
          end_us: 1_000_000,
          display_text: "你好",
          tokens: [
            {
              token_id: "token-1",
              text: "你好",
              start_us: 0,
              end_us: 1_000_000,
              language: "zh",
              confidence: 1,
            },
          ],
        },
      ],
    },
    editBrief: {
      schema_version: "1.0-alpha",
      brief_id: "brief-1",
      project_id: "project-cli-1",
      base_revision: initialRevision,
      audio_mode: "original",
      caption_style_id: "caption_clean",
      approved: true,
    },
  });
  return root;
}

async function legacyPublicProjectFixture(): Promise<string> {
  const root = await projectFixture(0);
  const state = join(root, ".creatorcut");
  const opened = await openCreatorCutProject(root);
  await commitLocalRevision(root, {
    baseRevision: 0,
    operationIds: ["legacy-public-fixture:commit:1"],
    nextTimeline: opened.timeline,
  });
  const operationPath = join(state, "operations.jsonl");
  const legacyOperations = (await readFile(operationPath, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => {
      const operation = JSON.parse(line) as Record<string, unknown>;
      delete operation.kind;
      return JSON.stringify(operation);
    })
    .join("\n");
  await writeFile(operationPath, `${legacyOperations}\n`, "utf8");
  await rmdir(join(state, ".public-mutation"));
  await Promise.all([
    unlink(join(state, "storage-authority.json")),
    unlink(join(state, "storage-mutations.jsonl")),
  ]);
  return root;
}

const io = (stdin = "") => ({
  stdin: async () => stdin,
  stdout: () => undefined,
});

describe("creatorcut CLI", () => {
  it("reports the public client version through the stable envelope", async () => {
    const packageManifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const result = await executeCli(["version"], io(), {
      credentials: new MemoryCredentialStore(),
    });

    expect(result).toMatchObject({
      ok: true,
      command: "version",
      data: { version: packageManifest.version },
    });

    await expect(
      executeCli(["--version"], io(), {
        credentials: new MemoryCredentialStore(),
      }),
    ).resolves.toEqual(result);
  });

  it("fails closed before internal migration commands can resolve or mutate a project", async () => {
    const resolveProject = vi.fn(() => {
      throw new Error("blocked authority command resolved a project");
    });
    const blockedCommands = [
      ["project", "migrate-internal", "--backup", "/unused/backup"],
      ["project", "rollback-internal", "--backup", "/unused/backup"],
    ];

    for (const argv of blockedCommands) {
      const result = await executeCli(argv, io(), {
        credentials: new MemoryCredentialStore(),
        cwd: resolveProject,
      });

      expect(result).toMatchObject({
        ok: false,
        command: argv.slice(0, 2).join(" "),
        retryable: false,
        error: {
          code: "invalid_input",
          message:
            "CreatorCut internal storage migration and rollback are disabled: the production native whole-tree swap/WAL gate is not complete",
        },
      });
    }

    expect(resolveProject).not.toHaveBeenCalled();
    expect(publicRuntime).toHaveProperty("adoptLegacyPublicProject");
    expect(publicRuntime).not.toHaveProperty("migrateLegacyInternalProject");
    expect(publicRuntime).not.toHaveProperty(
      "rollbackStorageAuthorityMigration",
    );
  });

  it("requires explicit confirmation before resolving a public adoption project", async () => {
    const resolveProject = vi.fn(() => {
      throw new Error("unconfirmed adoption resolved a project");
    });
    const result = await executeCli(["project", "adopt-public"], io(), {
      credentials: new MemoryCredentialStore(),
      cwd: resolveProject,
    });

    expect(result).toMatchObject({
      ok: false,
      command: "project adopt-public",
      error: {
        code: "invalid_input",
        message:
          "Explicit --confirm-local is required; it confirms all v0.2.1 CreatorCut processes are stopped and no preview, Director, export, or transcription work is in progress",
      },
    });
    expect(resolveProject).not.toHaveBeenCalled();
  });

  it("adopts an unmarked public project without enabling internal migration", async () => {
    const projectDirectory = await legacyPublicProjectFixture();
    const adapterFactory = vi.fn();
    const credentials = new MemoryCredentialStore();
    const credentialCalls = [
      vi.spyOn(credentials, "setApiKey"),
      vi.spyOn(credentials, "getApiKey"),
      vi.spyOn(credentials, "hasApiKey"),
      vi.spyOn(credentials, "deleteApiKey"),
    ];
    const adopted = await executeCli(
      [
        "project",
        "adopt-public",
        "--project",
        projectDirectory,
        "--confirm-local",
      ],
      io(),
      {
        credentials,
        adapterFactory,
      },
    );

    expect(adopted).toMatchObject({
      ok: true,
      command: "project adopt-public",
      project_revision: 1,
      next_suggested: "project status --project PROJECT_DIRECTORY",
      next_argv: ["project", "status", "--project", projectDirectory],
      data: {
        authority: "public-runtime",
        source_format: "creatorcut-public-runtime/1.0",
      },
    });
    expect(adapterFactory).not.toHaveBeenCalled();
    for (const call of credentialCalls) expect(call).not.toHaveBeenCalled();
    await expect(
      executeCli(adopted.next_argv!, io(), {
        credentials: new MemoryCredentialStore(),
      }),
    ).resolves.toMatchObject({ ok: true, command: "project status" });
  });

  it("doctor verifies every managed media dependency", async () => {
    const root = await mkdtemp(join(tmpdir(), "creatorcut-doctor-"));
    const executable = join(root, "tool");
    const model = join(root, "model.bin");
    await writeFile(executable, "", { mode: 0o755 });
    await writeFile(model, "model");
    const names = [
      "CREATORCUT_FFMPEG",
      "CREATORCUT_FFPROBE",
      "CREATORCUT_WHISPER",
      "CREATORCUT_WHISPER_MODEL",
    ] as const;
    const previous = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );
    try {
      process.env.CREATORCUT_FFMPEG = executable;
      process.env.CREATORCUT_FFPROBE = executable;
      process.env.CREATORCUT_WHISPER = executable;
      process.env.CREATORCUT_WHISPER_MODEL = model;
      const result = await executeCli(["doctor"], io(), {
        credentials: new MemoryCredentialStore(),
      });
      expect(result).toMatchObject({
        ok: true,
        command: "doctor",
        data: {
          product: "AgentMesh-CreatorCut",
          dependencies_ready: true,
          dependencies: {
            node: { ready: true },
            ffmpeg: { ready: true },
            ffprobe: { ready: true },
            whisper: { ready: true },
            whisper_model: { ready: true },
          },
        },
      });
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("doctor resolves default media executables from PATH without a shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "creatorcut-doctor-path-"));
    const model = join(root, "model.bin");
    const executableNames =
      process.platform === "win32"
        ? ["ffmpeg.EXE", "ffprobe.EXE", "whisper-cli.EXE"]
        : ["ffmpeg", "ffprobe", "whisper-cli"];
    await Promise.all([
      ...executableNames.map((name) =>
        writeFile(join(root, name), "", { mode: 0o755 }),
      ),
      writeFile(model, "model"),
    ]);
    const names = [
      "CREATORCUT_FFMPEG",
      "CREATORCUT_FFPROBE",
      "CREATORCUT_WHISPER",
      "CREATORCUT_WHISPER_MODEL",
      "PATH",
      "PATHEXT",
    ] as const;
    const previous = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );
    try {
      delete process.env.CREATORCUT_FFMPEG;
      delete process.env.CREATORCUT_FFPROBE;
      delete process.env.CREATORCUT_WHISPER;
      process.env.CREATORCUT_WHISPER_MODEL = model;
      process.env.PATH = root;
      if (process.platform === "win32") process.env.PATHEXT = ".EXE;.CMD";

      const result = await executeCli(["doctor"], io(), {
        credentials: new MemoryCredentialStore(),
      });
      expect(result).toMatchObject({
        ok: true,
        data: {
          dependencies_ready: true,
          dependencies: {
            ffmpeg: { path: join(root, executableNames[0]!), ready: true },
            ffprobe: { path: join(root, executableNames[1]!), ready: true },
            whisper: { path: join(root, executableNames[2]!), ready: true },
            whisper_model: { path: model, ready: true },
          },
        },
      });

      await unlink(join(root, executableNames[0]!));
      await mkdir(join(root, executableNames[0]!));
      if (process.platform === "win32") {
        await writeFile(join(root, "ffmpeg.CMD"), "@exit /b 0\r\n");
      }
      const invalidExecutable = await executeCli(["doctor"], io(), {
        credentials: new MemoryCredentialStore(),
      });
      expect(invalidExecutable).toMatchObject({
        ok: true,
        data: {
          dependencies: {
            ffmpeg: { path: null, ready: false },
          },
        },
      });
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("doctor never hides an invalid explicit executable behind PATH fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "creatorcut-doctor-precedence-"));
    const ffmpeg = join(
      root,
      process.platform === "win32" ? "ffmpeg.EXE" : "ffmpeg",
    );
    const missing = join(root, "configured-ffmpeg-is-missing");
    await writeFile(ffmpeg, "", { mode: 0o755 });
    const previousPath = process.env.PATH;
    const previousFfmpeg = process.env.CREATORCUT_FFMPEG;
    try {
      process.env.PATH = `${root}${delimiter}${previousPath ?? ""}`;
      process.env.CREATORCUT_FFMPEG = missing;
      const result = await executeCli(["doctor"], io(), {
        credentials: new MemoryCredentialStore(),
      });
      expect(result).toMatchObject({
        ok: true,
        data: {
          dependencies: {
            ffmpeg: { path: missing, ready: false },
          },
        },
      });

      process.env.CREATORCUT_FFMPEG = "";
      const emptyConfiguration = await executeCli(["doctor"], io(), {
        credentials: new MemoryCredentialStore(),
      });
      expect(emptyConfiguration).toMatchObject({
        ok: true,
        data: {
          dependencies: {
            ffmpeg: { path: ffmpeg, ready: true },
          },
        },
      });

      if (process.platform === "win32") {
        const batch = join(root, "ffmpeg.CMD");
        await writeFile(batch, "@exit /b 0\r\n");
        process.env.CREATORCUT_FFMPEG = batch;
        const batchConfiguration = await executeCli(["doctor"], io(), {
          credentials: new MemoryCredentialStore(),
        });
        expect(batchConfiguration).toMatchObject({
          ok: true,
          data: {
            dependencies: {
              ffmpeg: { path: batch, ready: false },
            },
          },
        });
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousFfmpeg === undefined) delete process.env.CREATORCUT_FFMPEG;
      else process.env.CREATORCUT_FFMPEG = previousFfmpeg;
    }
  });

  it("onboard starts with secure authentication after a managed install", async () => {
    const root = await mkdtemp(join(tmpdir(), "creatorcut-onboard-"));
    const executable = join(root, "tool");
    const model = join(root, "model.bin");
    await writeFile(executable, "", { mode: 0o755 });
    await writeFile(model, "model");
    const names = [
      "CREATORCUT_FFMPEG",
      "CREATORCUT_FFPROBE",
      "CREATORCUT_WHISPER",
      "CREATORCUT_WHISPER_MODEL",
    ] as const;
    const previous = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );
    try {
      process.env.CREATORCUT_FFMPEG = executable;
      process.env.CREATORCUT_FFPROBE = executable;
      process.env.CREATORCUT_WHISPER = executable;
      process.env.CREATORCUT_WHISPER_MODEL = model;
      const result = await executeCli(["onboard"], io(), {
        credentials: new MemoryCredentialStore(),
        cwd: () => root,
      });

      expect(result).toMatchObject({
        ok: true,
        command: "onboard",
        requires_user_action: true,
        next_suggested: "auth login",
        data: {
          stage: "authenticate",
          complete: false,
          checks: {
            dependencies_ready: true,
            authenticated: false,
            project: false,
          },
        },
      });
      expect(JSON.stringify(result)).not.toContain("API key is required");
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("onboard asks for local media after authentication", async () => {
    const root = await mkdtemp(join(tmpdir(), "creatorcut-onboard-auth-"));
    const executable = join(root, "tool");
    const model = join(root, "model.bin");
    await writeFile(executable, "", { mode: 0o755 });
    await writeFile(model, "model");
    const credentials = new MemoryCredentialStore();
    await credentials.setApiKey("am_test_key");
    const names = [
      "CREATORCUT_FFMPEG",
      "CREATORCUT_FFPROBE",
      "CREATORCUT_WHISPER",
      "CREATORCUT_WHISPER_MODEL",
    ] as const;
    const previous = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );
    try {
      process.env.CREATORCUT_FFMPEG = executable;
      process.env.CREATORCUT_FFPROBE = executable;
      process.env.CREATORCUT_WHISPER = executable;
      process.env.CREATORCUT_WHISPER_MODEL = model;
      const result = await executeCli(["onboard"], io(), {
        credentials,
        cwd: () => root,
      });

      expect(result).toMatchObject({
        ok: true,
        command: "onboard",
        requires_user_action: true,
        next_suggested:
          "media import --source <recording.mov> --project <project.creatorcut>",
        data: {
          stage: "import_media",
          checks: {
            authenticated: true,
            project: false,
          },
        },
      });
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("onboard resumes an existing project at explicit Director consent", async () => {
    const project = await projectFixture();
    const executable = join(project, "tool");
    const model = join(project, "model.bin");
    const keyset = join(project, "director-keyset.json");
    const roots = join(project, "director-recovery-roots.json");
    await Promise.all([
      writeFile(executable, "", { mode: 0o755 }),
      writeFile(model, "model"),
      writeFile(keyset, "{}"),
      writeFile(roots, "{}"),
    ]);
    const credentials = new MemoryCredentialStore();
    await credentials.setApiKey("am_test_key");
    const values = {
      CREATORCUT_FFMPEG: executable,
      CREATORCUT_FFPROBE: executable,
      CREATORCUT_WHISPER: executable,
      CREATORCUT_WHISPER_MODEL: model,
      CREATORCUT_DIRECTOR_ENDPOINT: "https://api.creatorcut.agentmesh360.com",
      CREATORCUT_DIRECTOR_KEYSET: keyset,
      CREATORCUT_DIRECTOR_RECOVERY_ROOTS: roots,
      CREATORCUT_PROTOCOL_BUNDLE_DIGEST: `sha256:${"a".repeat(64)}`,
    } as const;
    const previous = Object.fromEntries(
      Object.keys(values).map((name) => [name, process.env[name]]),
    );
    try {
      Object.assign(process.env, values);
      const result = await executeCli(["onboard", "--project", project], io(), {
        credentials,
      });

      expect(result).toMatchObject({
        ok: true,
        command: "onboard",
        requires_user_action: true,
        next_suggested: "director context inspect --project PROJECT_DIRECTORY",
        next_argv: ["director", "context", "inspect", "--project", project],
        data: {
          stage: "inspect_director_context",
          checks: {
            dependencies_ready: true,
            director_configuration_ready: true,
            authenticated: true,
            project: true,
          },
          project: {
            transcript_segments: 1,
            director_consent: false,
          },
        },
      });
    } finally {
      for (const name of Object.keys(values)) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("defers upgrades while a resumable local task is active", async () => {
    const project = await projectFixture();
    await writeLocalArtifact(project, "tasks/export.json", {
      schema_version: "creatorcut-export-task/1.0",
      task_id: "export:upgrade-deferral",
      project_id: "project-cli-1",
      base_revision: 1,
      state: "running",
      progress_millis: 100,
      created_at: "2026-08-09T00:00:00.000Z",
      updated_at: "2026-08-09T00:00:01.000Z",
    });

    const result = await executeCli(
      ["upgrade-check", "--project", project],
      io(),
      { credentials: new MemoryCredentialStore() },
    );

    expect(result).toMatchObject({
      ok: true,
      command: "upgrade-check",
      next_suggested: "export status --project PROJECT_DIRECTORY",
      next_argv: ["export", "status", "--project", project],
      data: {
        compatible: true,
        update_safe: false,
        active_tasks: [{ kind: "export", state: "running" }],
      },
    });
  });

  it("stores auth through the credential abstraction and returns stable JSON", async () => {
    const credentials = new MemoryCredentialStore();
    const project = resolve(
      tmpdir(),
      "creatorcut-$(do-not-run)-%DO_NOT_EXPAND%.creatorcut",
    );
    const login = await executeCli(
      ["auth", "login", "--project", project],
      io("am_test_key\n"),
      { credentials },
    );
    expect(login).toMatchObject({
      schema_version: "creatorcut-cli/1.0",
      ok: true,
      command: "auth login",
      requires_user_action: false,
      next_suggested: "onboard --project PROJECT_DIRECTORY",
      next_argv: ["onboard", "--project", project],
    });
    expect(login.next_suggested).not.toContain(project);
    expect(await credentials.getApiKey()).toBe("am_test_key");
  });

  it("resumes manual authentication through scoped auth status", async () => {
    const credentials = new MemoryCredentialStore();
    const project = resolve(
      tmpdir(),
      "creatorcut-auth-resume-$(do-not-run).creatorcut",
    );
    const missing = await executeCli(
      ["auth", "status", "--project", project],
      io(),
      { credentials },
    );
    expect(missing).toMatchObject({
      ok: true,
      command: "auth status",
      requires_user_action: true,
      next_suggested: "auth login --project PROJECT_DIRECTORY",
      next_argv: ["auth", "login", "--project", project],
      data: { authenticated: false },
    });

    await credentials.setApiKey("am_test_key");
    const authenticated = await executeCli(
      ["auth", "status", "--project", project],
      io(),
      { credentials },
    );
    expect(authenticated).toMatchObject({
      ok: true,
      command: "auth status",
      requires_user_action: false,
      next_suggested: "onboard --project PROJECT_DIRECTORY",
      next_argv: ["onboard", "--project", project],
      data: { authenticated: true },
    });
    expect(authenticated.next_suggested).not.toContain(project);
    const continued = withNextProcess(authenticated, {
      executable: process.execPath,
      mainModule: resolve(import.meta.dirname, "../dist/src/main.js"),
      cwd: resolve(import.meta.dirname, ".."),
      environment: {},
    });
    expect(
      JSON.parse(
        continued.next_openclaw!.exec.env[OPENCLAW_REQUEST_ENVIRONMENT]!,
      ),
    ).toEqual({
      argv: ["onboard", "--project", project],
      stdin_mode: "none",
    });
  });

  it.each(["--key", "--key=am_leaked"])(
    "rejects API keys passed through argv as %s",
    async (keyArgument) => {
      const result = await executeCli(
        ["auth", "login", keyArgument, "am_leaked"],
        io(),
        { credentials: new MemoryCredentialStore() },
      );
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("am_leaked");
    },
  );

  it("requires inspect then explicit project-level consent", async () => {
    const project = await projectFixture();
    const inspect = await executeCli(
      ["director", "context", "inspect", "--project", project],
      io(),
      { credentials: new MemoryCredentialStore() },
    );
    expect(inspect).toMatchObject({
      ok: true,
      requires_user_action: true,
      next_suggested:
        "director context consent --confirm-upload --project PROJECT_DIRECTORY",
      next_argv: [
        "director",
        "context",
        "consent",
        "--confirm-upload",
        "--project",
        project,
      ],
    });
    const denied = await executeCli(
      ["director", "context", "consent", "--project", project],
      io(),
      { credentials: new MemoryCredentialStore() },
    );
    expect(denied.ok).toBe(false);
    const approved = await executeCli(
      [
        "director",
        "context",
        "consent",
        "--project",
        project,
        "--confirm-upload",
      ],
      io(),
      { credentials: new MemoryCredentialStore() },
    );
    expect(approved.ok).toBe(true);
  });

  it("shows and safely replaces a human-corrected bilingual transcript", async () => {
    const project = await projectFixture();
    const shown = await executeCli(
      ["transcribe", "show", "--project", project],
      io(),
      { credentials: new MemoryCredentialStore() },
    );
    expect(shown).toMatchObject({
      ok: true,
      data: { transcript_id: "transcript-1", language_mode: "zh" },
    });
    const correctedPath = join(project, "corrected-transcript.json");
    await writeFile(
      correctedPath,
      JSON.stringify({
        ...(shown.data as Record<string, unknown>),
        language_mode: "mixed",
        segments: [
          {
            segment_id: "segment-1",
            source_asset_id: "asset-1",
            start_us: 0,
            end_us: 1_000_000,
            display_text: "你好 CreatorCut",
            tokens: [
              {
                token_id: "token-1",
                text: "你好",
                start_us: 0,
                end_us: 400_000,
                language: "zh",
                confidence: 1,
              },
              {
                token_id: "token-2",
                text: "CreatorCut",
                start_us: 450_000,
                end_us: 1_000_000,
                language: "en",
                confidence: 1,
              },
            ],
          },
        ],
      }),
      "utf8",
    );
    const replaced = await executeCli(
      ["transcribe", "replace", "--project", project, "--file", correctedPath],
      io(),
      { credentials: new MemoryCredentialStore() },
    );
    expect(replaced).toMatchObject({
      ok: true,
      next_suggested: "director context inspect --project PROJECT_DIRECTORY",
      next_argv: ["director", "context", "inspect", "--project", project],
      data: { language_mode: "mixed" },
    });
  });

  it("keeps a migrated visual handoff on verify/redo routing and blocks every export entry", async () => {
    const { projectDirectory, approvalToken } = await migratedHandoffFixture();
    const credentials = new MemoryCredentialStore();
    const output = join(projectDirectory, "exports", "blocked.mp4");
    const taskPath = join(
      projectDirectory,
      ".creatorcut",
      "tasks",
      "export.json",
    );

    const activeStatus = await executeCli(
      ["project", "status", "--project", projectDirectory],
      io(),
      { credentials },
    );
    expect(activeStatus).toMatchObject({
      ok: true,
      next_suggested: "handoff verify --project PROJECT_DIRECTORY",
      next_argv: ["handoff", "verify", "--project", projectDirectory],
      data: { handoff_visual_state: "active" },
    });
    expect(JSON.stringify(activeStatus)).not.toContain(
      "preview_approval_token",
    );

    const verification = await executeCli(
      ["handoff", "verify", "--project", projectDirectory],
      io(),
      { credentials },
    );
    expect(verification).toMatchObject({
      ok: true,
      next_suggested: "export plan --project PROJECT_DIRECTORY",
      next_argv: ["export", "plan", "--project", projectDirectory],
      data: {
        visual_state: "active",
        preview_approval_present: true,
        preview_binding_valid: true,
        visual_render_supported: false,
      },
    });
    expect(JSON.stringify(verification)).not.toContain(approvalToken);

    const plan = await executeCli(
      ["export", "plan", "--project", projectDirectory, "--output", output],
      io(),
      { credentials },
    );
    expect(plan).toMatchObject({
      ok: true,
      next_suggested: "handoff verify --project PROJECT_DIRECTORY",
      next_argv: ["handoff", "verify", "--project", projectDirectory],
      data: {
        ready: false,
        visual_render_supported: false,
        writes_media: false,
        starts_export_task: false,
      },
    });
    await expect(access(taskPath)).rejects.toMatchObject({ code: "ENOENT" });

    const start = await executeCli(
      ["export", "start", "--project", projectDirectory, "--output", output],
      io(),
      { credentials },
    );
    expect(start).toMatchObject({ ok: false });
    expect(JSON.stringify(start)).toMatch(
      /cannot materialize|not yet supported/u,
    );
    await expect(access(taskPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });

    await writeLocalArtifact(projectDirectory, "tasks/export.json", {
      schema_version: "creatorcut-export-task/1.0",
      task_id: "export:cli-visual-bypass",
      project_id: "cli-handoff-fixture",
      base_revision: 3,
      state: "queued",
      progress_millis: 0,
      created_at: "2026-08-09T00:00:00.000Z",
      updated_at: "2026-08-09T00:00:00.000Z",
    });
    await writeLocalArtifact(projectDirectory, "tasks/export-locator.json", {
      schema_version: "creatorcut-export-locator/1.0",
      output_path: output,
      ffmpeg_path: "ffmpeg",
      ffprobe_path: "ffprobe",
      overwrite: false,
    });
    const taskBeforeResume = await readFile(taskPath);
    const resume = await executeCli(
      ["export", "resume", "--project", projectDirectory],
      io(),
      { credentials },
    );
    expect(resume).toMatchObject({ ok: false });
    expect(await readFile(taskPath)).toEqual(taskBeforeResume);
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });

    const undone = await executeCli(
      ["edit", "undo", "--project", projectDirectory],
      io(),
      { credentials },
    );
    expect(undone).toMatchObject({
      ok: true,
      project_revision: 4,
      next_suggested: "handoff verify --project PROJECT_DIRECTORY",
      next_argv: ["handoff", "verify", "--project", projectDirectory],
    });
    const undoneStatus = await executeCli(
      ["project", "status", "--project", projectDirectory],
      io(),
      { credentials },
    );
    expect(undoneStatus).toMatchObject({
      ok: true,
      next_suggested: "edit redo --project PROJECT_DIRECTORY",
      next_argv: ["edit", "redo", "--project", projectDirectory],
      data: { handoff_visual_state: "redo_available" },
    });
    expect(JSON.stringify(undoneStatus)).not.toMatch(
      /transcribe start|director context/u,
    );

    const historyPath = join(projectDirectory, ".creatorcut", "history.json");
    const markerPath = join(
      projectDirectory,
      ".creatorcut",
      "storage-authority.json",
    );
    const [taskAfterUndo, historyAfterUndo, markerAfterUndo] =
      await Promise.all([
        readFile(taskPath),
        readFile(historyPath),
        readFile(markerPath),
      ]);
    const undonePlan = await executeCli(
      ["export", "plan", "--project", projectDirectory, "--output", output],
      io(),
      { credentials },
    );
    expect(undonePlan).toMatchObject({
      ok: true,
      next_suggested: "handoff verify --project PROJECT_DIRECTORY",
      next_argv: ["handoff", "verify", "--project", projectDirectory],
      data: { ready: false, visual_render_supported: false },
    });
    const undoneStart = await executeCli(
      ["export", "start", "--project", projectDirectory, "--output", output],
      io(),
      { credentials },
    );
    expect(undoneStart).toMatchObject({ ok: false });
    const undoneResume = await executeCli(
      ["export", "resume", "--project", projectDirectory],
      io(),
      { credentials },
    );
    expect(undoneResume).toMatchObject({ ok: false });
    expect(JSON.stringify(undoneResume)).toMatch(
      /cannot materialize|not yet supported/u,
    );
    const storedTask = JSON.parse(taskAfterUndo.toString("utf8"));
    const storedLocator = JSON.parse(
      await readFile(
        join(projectDirectory, ".creatorcut", "tasks", "export-locator.json"),
        "utf8",
      ),
    );
    await expect(
      runExportTask(projectDirectory, storedTask, storedLocator),
    ).rejects.toThrow(/cannot materialize/u);
    expect(await readFile(taskPath)).toEqual(taskAfterUndo);
    expect(await readFile(historyPath)).toEqual(historyAfterUndo);
    expect(await readFile(markerPath)).toEqual(markerAfterUndo);
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });

    const redone = await executeCli(
      ["edit", "redo", "--project", projectDirectory],
      io(),
      { credentials },
    );
    expect(redone).toMatchObject({
      ok: true,
      project_revision: 5,
      next_suggested: "handoff verify --project PROJECT_DIRECTORY",
      next_argv: ["handoff", "verify", "--project", projectDirectory],
    });
    const redoneStatus = await executeCli(
      ["project", "status", "--project", projectDirectory],
      io(),
      { credentials },
    );
    expect(redoneStatus).toMatchObject({
      ok: true,
      next_suggested: "handoff verify --project PROJECT_DIRECTORY",
      next_argv: ["handoff", "verify", "--project", projectDirectory],
      data: { handoff_visual_state: "active" },
    });
  }, 20_000);

  it("routes a migrated project with no visual handoff through the ordinary public workflow", async () => {
    const { projectDirectory } = await migratedNoVisualFixture();
    const credentials = new MemoryCredentialStore();
    const output = join(projectDirectory, "exports", "planned-only.mp4");
    const bin = join(projectDirectory, "test-bin");
    const model = join(projectDirectory, "whisper-model.bin");
    const executableNames =
      process.platform === "win32"
        ? ["ffmpeg.EXE", "ffprobe.EXE", "whisper-cli.EXE"]
        : ["ffmpeg", "ffprobe", "whisper-cli"];
    const taskPath = join(
      projectDirectory,
      ".creatorcut",
      "tasks",
      "export.json",
    );
    const environmentNames = [
      "CREATORCUT_FFMPEG",
      "CREATORCUT_FFPROBE",
      "CREATORCUT_WHISPER",
      "CREATORCUT_WHISPER_MODEL",
      "PATH",
      "PATHEXT",
    ] as const;
    const previousEnvironment = Object.fromEntries(
      environmentNames.map((name) => [name, process.env[name]]),
    );
    await mkdir(bin);
    await Promise.all(
      executableNames.map((name) =>
        writeFile(join(bin, name), "", { mode: 0o755 }),
      ),
    );
    delete process.env.CREATORCUT_FFMPEG;
    delete process.env.CREATORCUT_FFPROBE;
    delete process.env.CREATORCUT_WHISPER;
    delete process.env.CREATORCUT_WHISPER_MODEL;
    process.env.PATH = bin;
    if (process.platform === "win32") process.env.PATHEXT = ".EXE;.CMD";

    try {
      const status = await executeCli(
        ["project", "status", "--project", projectDirectory],
        io(),
        { credentials },
      );
      expect(status).toMatchObject({
        ok: true,
        requires_user_action: true,
        next_suggested: "doctor --project PROJECT_DIRECTORY",
        next_argv: ["doctor", "--project", projectDirectory],
        data: { visual_handoff_present: false },
      });
      expect(status.user_prompt).toMatch(/CREATORCUT_WHISPER_MODEL/iu);
      expect(status.next_suggested).not.toMatch(
        /transcribe start|handoff verify|director/u,
      );

      const opened = await executeCli(
        ["project", "open", "--project", projectDirectory],
        io(),
        { credentials },
      );
      expect(opened).toMatchObject({
        ok: true,
        requires_user_action: true,
        next_suggested: "doctor --project PROJECT_DIRECTORY",
        next_argv: ["doctor", "--project", projectDirectory],
      });

      const doctor = await executeCli(
        ["doctor", "--project", projectDirectory],
        io(),
        { credentials },
      );
      expect(doctor).toMatchObject({
        ok: true,
        next_suggested: "onboard --project PROJECT_DIRECTORY",
        next_argv: ["onboard", "--project", projectDirectory],
      });

      await writeFile(model, "model");
      process.env.CREATORCUT_WHISPER_MODEL = model;
      const configuredStatus = await executeCli(
        ["project", "status", "--project", projectDirectory],
        io(),
        { credentials },
      );
      expect(configuredStatus).toMatchObject({
        ok: true,
        requires_user_action: false,
        next_suggested:
          "transcribe start --language auto --project PROJECT_DIRECTORY",
        next_argv: [
          "transcribe",
          "start",
          "--language",
          "auto",
          "--project",
          projectDirectory,
        ],
      });
      expect(configuredStatus).not.toHaveProperty("user_prompt");

      process.env.CREATORCUT_WHISPER = join(bin, "missing-whisper-cli");
      const brokenExecutableStatus = await executeCli(
        ["project", "status", "--project", projectDirectory],
        io(),
        { credentials },
      );
      expect(brokenExecutableStatus).toMatchObject({
        ok: true,
        requires_user_action: true,
        next_suggested: "doctor --project PROJECT_DIRECTORY",
        next_argv: ["doctor", "--project", projectDirectory],
      });
      expect(brokenExecutableStatus.user_prompt).toMatch(/whisper-cli/iu);
    } finally {
      for (const name of environmentNames) {
        const value = previousEnvironment[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    const verification = await executeCli(
      ["handoff", "verify", "--project", projectDirectory],
      io(),
      { credentials },
    );
    expect(verification).toMatchObject({
      ok: true,
      next_suggested: "project status --project PROJECT_DIRECTORY",
      next_argv: ["project", "status", "--project", projectDirectory],
      data: {
        visual_handoff_present: false,
        next: "public_workflow",
        director_context_uploaded: false,
        director_consent_created: false,
      },
    });

    const plan = await executeCli(
      ["export", "plan", "--project", projectDirectory, "--output", output],
      io(),
      { credentials },
    );
    expect(plan).toMatchObject({
      ok: true,
      next_suggested:
        "export start --output <path.mp4> --project PROJECT_DIRECTORY",
      data: {
        ready: true,
        visual_render_supported: false,
        writes_media: false,
        starts_export_task: false,
      },
    });
    await expect(access(taskPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns the stable answer id with every card presentation", async () => {
    const presentationDigest = `sha256:${"d".repeat(64)}`;
    const projectInput = "/synthetic/project";
    const projectDirectory = resolve(projectInput);
    const adapter = {
      getCards: async () => ({
        envelope: { artifact_id: "cards-cli" },
        presentation: {
          presentation_digest: presentationDigest,
          text_fallback: "[pace] Choose a pace",
        },
      }),
    } as unknown as CloudDirectorAdapter;
    const result = await executeCli(
      ["cards", "get", "--project", projectInput],
      io(),
      {
        adapterFactory: async () => adapter,
        credentials: new MemoryCredentialStore(),
      },
    );
    expect(result).toMatchObject({
      ok: true,
      requires_user_action: true,
      next_suggested: "cards submit --project PROJECT_DIRECTORY",
      next_argv: ["cards", "submit", "--project", projectDirectory],
      data: {
        answer_set_id: `answers:${"d".repeat(32)}`,
        presentation: { presentation_digest: presentationDigest },
      },
    });
  });
});
