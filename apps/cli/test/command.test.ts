import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MemoryCredentialStore } from "@agentmesh/creatorcut-credentials";
import type { CloudDirectorAdapter } from "@agentmesh/creatorcut-director-client";

import { executeCli } from "../src/index.js";

async function projectFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "creatorcut-cli-"));
  const state = join(root, ".creatorcut");
  await mkdir(state);
  const write = (name: string, value: unknown) =>
    writeFile(join(state, name), JSON.stringify(value), "utf8");
  await write("project.json", {
    schema_version: "1.0-alpha",
    project_id: "project-cli-1",
    name: "CLI fixture",
    revision: 1,
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
  });
  await write("timeline.json", {
    schema_version: "1.0-alpha",
    timeline_id: "timeline-1",
    project_id: "project-cli-1",
    revision: 1,
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
  });
  await write("transcript.json", {
    schema_version: "1.0-alpha",
    transcript_id: "transcript-1",
    project_id: "project-cli-1",
    revision: 1,
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
  });
  await write("edit-brief.json", {
    schema_version: "1.0-alpha",
    brief_id: "brief-1",
    project_id: "project-cli-1",
    base_revision: 1,
    audio_mode: "original",
    caption_style_id: "caption_clean",
    approved: true,
  });
  return root;
}

const io = (stdin = "") => ({
  stdin: async () => stdin,
  stdout: () => undefined,
});

describe("creatorcut CLI", () => {
  it("reports the public client version through the stable envelope", async () => {
    const result = await executeCli(["version"], io(), {
      credentials: new MemoryCredentialStore(),
    });

    expect(result).toMatchObject({
      ok: true,
      command: "version",
      data: { version: "0.2.1" },
    });
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
        next_suggested: `director context inspect --project ${JSON.stringify(project)}`,
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
    await mkdir(join(project, ".creatorcut", "tasks"));
    await writeFile(
      join(project, ".creatorcut", "tasks", "export.json"),
      JSON.stringify({ state: "running" }),
      "utf8",
    );

    const result = await executeCli(
      ["upgrade-check", "--project", project],
      io(),
      { credentials: new MemoryCredentialStore() },
    );

    expect(result).toMatchObject({
      ok: true,
      command: "upgrade-check",
      next_suggested: "export status",
      data: {
        compatible: true,
        update_safe: false,
        active_tasks: [{ kind: "export", state: "running" }],
      },
    });
  });

  it("stores auth through the credential abstraction and returns stable JSON", async () => {
    const credentials = new MemoryCredentialStore();
    const login = await executeCli(["auth", "login"], io("am_test_key\n"), {
      credentials,
    });
    expect(login).toMatchObject({
      schema_version: "creatorcut-cli/1.0",
      ok: true,
      command: "auth login",
      requires_user_action: false,
      next_suggested: "onboard",
    });
    expect(await credentials.getApiKey()).toBe("am_test_key");
  });

  it("rejects API keys passed through argv", async () => {
    const result = await executeCli(
      ["auth", "login", "--key", "am_leaked"],
      io(),
      { credentials: new MemoryCredentialStore() },
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("am_leaked");
  });

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
      next_suggested: "director context consent --confirm-upload",
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
      next_suggested: "director context inspect",
      data: { language_mode: "mixed" },
    });
  });

  it("returns the stable answer id with every card presentation", async () => {
    const presentationDigest = `sha256:${"d".repeat(64)}`;
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
      ["cards", "get", "--project", "/synthetic/project"],
      io(),
      {
        adapterFactory: async () => adapter,
        credentials: new MemoryCredentialStore(),
      },
    );
    expect(result).toMatchObject({
      ok: true,
      requires_user_action: true,
      next_suggested: "cards submit",
      data: {
        answer_set_id: `answers:${"d".repeat(32)}`,
        presentation: { presentation_digest: presentationDigest },
      },
    });
  });
});
