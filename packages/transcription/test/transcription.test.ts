import {
  access,
  chmod,
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

import {
  commitLocalRevision,
  createCreatorCutProject,
  openCreatorCutProject,
} from "@agentmesh/creatorcut-runtime";
import type { ProcessRunner } from "@agentmesh/creatorcut-media-engine";
import { describe, expect, it } from "vitest";

import {
  detectTranscriptLanguage,
  cancelTranscriptionTask,
  clearTranscriptionWork,
  parseSilence,
  parseWhisperJson,
  readTranscriptionTask,
  resumeTranscriptionTask,
  transcribeProject,
} from "../src/index.js";

const raw = {
  result: { language: "zh" },
  transcription: [
    {
      text: "你好 CreatorCut",
      timestamps: { from: "00:00:00,000", to: "00:00:02,000" },
      tokens: [
        {
          text: "你好",
          timestamps: { from: "00:00:00,000", to: "00:00:00,900" },
          p: 0.98,
        },
        {
          text: " CreatorCut",
          timestamps: { from: "00:00:01,000", to: "00:00:02,000" },
          p: 0.99,
        },
      ],
    },
  ],
};

const runner: ProcessRunner = async (command, args) => {
  if (command === "ffmpeg") {
    if (args.at(-1) !== "-") await writeFile(args.at(-1)!, "wav");
    return {
      exitCode: 0,
      stdout: "",
      stderr: args.at(-1) === "-" ? "silence_start: 2.5\nsilence_end: 3.0" : "",
    };
  }
  const outputIndex = args.indexOf("-of");
  const prefix = args[outputIndex + 1]!;
  await writeFile(`${prefix}.json`, JSON.stringify(raw));
  return { exitCode: 0, stdout: "", stderr: "" };
};

async function fixture(): Promise<{ directory: string; model: string }> {
  const root = await mkdtemp(join(tmpdir(), "creatorcut-asr-test-"));
  const directory = join(root, "project.creatorcut");
  await createCreatorCutProject(directory, {
    project: {
      schema_version: "1.0",
      project_id: "project-asr-1",
      name: "ASR fixture",
      revision: 0,
      assets: [
        {
          asset_id: "asset-source",
          kind: "video",
          relative_path: "media/source.mov",
          sha256: "a".repeat(64),
          duration_us: 5_000_000,
          width: 1920,
          height: 1080,
          has_video: true,
          has_audio: true,
        },
      ],
    },
    timeline: {
      schema_version: "1.0",
      timeline_id: "timeline-asr-1",
      project_id: "project-asr-1",
      revision: 0,
      duration_us: 5_000_000,
      canvas: { width: 1920, height: 1080 },
      tracks: [
        {
          track_id: "track-video",
          kind: "video",
          clips: [
            {
              clip_id: "clip-source",
              asset_id: "asset-source",
              source_start_us: 0,
              source_end_us: 5_000_000,
              timeline_start_us: 0,
              timeline_end_us: 5_000_000,
            },
          ],
        },
      ],
    },
  });
  await writeFile(join(directory, "media", "source.mov"), "media");
  const model = join(root, "model.bin");
  await writeFile(model, "model");
  return { directory, model };
}

describe("public bilingual transcription", () => {
  it("maps stable Chinese and English timed tokens", () => {
    const transcript = parseWhisperJson(raw, {
      projectId: "project-asr-1",
      projectRevision: 0,
      sourceAssetId: "asset-source",
      languageMode: "mixed",
    });
    expect(
      transcript.segments[0]?.tokens.map((token) => token.language),
    ).toEqual(["zh", "en"]);
    expect(detectTranscriptLanguage(transcript)).toBe("mixed");
    expect(
      parseSilence("silence_start: 1.0\nsilence_end: 2.0", "asset", 3_000_000),
    ).toHaveLength(1);
  });

  it("runs resumable mixed-language local candidates and persists the transcript", async () => {
    const { directory, model } = await fixture();
    const task = await transcribeProject({
      projectDirectory: directory,
      modelPath: model,
      languageMode: "mixed",
      runner,
    });
    expect(task.state).toBe("completed");
    expect(task.completed_steps).toEqual(
      expect.arrayContaining([
        "candidate_auto",
        "candidate_zh",
        "candidate_en",
      ]),
    );
    const opened = await openCreatorCutProject(directory);
    expect(opened.transcript.segments[0]?.display_text).toBe("你好 CreatorCut");
    expect(opened.transcript.silence_intervals).toHaveLength(1);
    const privateWork = join(directory, ".creatorcut-work", "transcription");
    expect(
      await access(privateWork)
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
    if (platform() !== "win32") {
      expect((await stat(privateWork)).mode & 0o777).toBe(0o700);
    }
    expect(
      await access(join(directory, "generated", "transcription-work"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    await clearTranscriptionWork(directory);
    expect(
      await access(privateWork)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  }, 15_000);

  it("does not reuse candidates after the model digest changes", async () => {
    const { directory, model } = await fixture();
    let whisperRuns = 0;
    const countingRunner: ProcessRunner = async (command, args) => {
      if (command === "ffmpeg") {
        if (args.at(-1) !== "-") await writeFile(args.at(-1)!, "wav");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      whisperRuns += 1;
      const outputIndex = args.indexOf("-of");
      await writeFile(`${args[outputIndex + 1]!}.json`, JSON.stringify(raw));
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await transcribeProject({
      projectDirectory: directory,
      modelPath: model,
      languageMode: "mixed",
      runner: countingRunner,
    });
    await writeFile(model, "different model");
    await transcribeProject({
      projectDirectory: directory,
      modelPath: model,
      languageMode: "mixed",
      runner: countingRunner,
    });
    expect(whisperRuns).toBe(6);
  }, 15_000);

  it.runIf(platform() !== "win32")(
    "keeps transcription intermediates in a 0700 private work root with 0600 files",
    async () => {
      const { directory, model } = await fixture();
      await transcribeProject({
        projectDirectory: directory,
        modelPath: model,
        languageMode: "auto",
        runner,
      });
      const privateRoot = join(directory, ".creatorcut-work");
      const transcriptionRoot = join(privateRoot, "transcription");
      expect((await stat(privateRoot)).mode & 0o777).toBe(0o700);
      expect((await stat(transcriptionRoot)).mode & 0o777).toBe(0o700);
      const [workName] = await readdir(transcriptionRoot);
      expect(workName).toBeDefined();
      const work = join(transcriptionRoot, workName!);
      expect((await stat(work)).mode & 0o777).toBe(0o700);
      for (const name of await readdir(work)) {
        expect((await stat(join(work, name))).mode & 0o777).toBe(0o600);
      }
      await expect(
        access(join(directory, "generated", "transcription-work")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  for (const attack of ["root", "transcription"] as const) {
    it(`rejects a ${attack} private-work symlink without writing outside`, async () => {
      const { directory, model } = await fixture();
      const outside = await mkdtemp(join(tmpdir(), "creatorcut-asr-outside-"));
      const sentinel = join(outside, "sentinel.txt");
      const sentinelBytes = Buffer.from("outside-must-remain");
      await writeFile(sentinel, sentinelBytes);
      const privateRoot = join(directory, ".creatorcut-work");
      if (attack === "root") {
        await symlink(outside, privateRoot);
      } else {
        await mkdir(privateRoot, { mode: 0o700 });
        await symlink(outside, join(privateRoot, "transcription"));
      }
      const before = (await readdir(outside)).sort();

      await expect(
        transcribeProject({
          projectDirectory: directory,
          modelPath: model,
          languageMode: "auto",
          runner,
        }),
      ).rejects.toThrow(/private work|symbolic link|trusted/u);
      expect((await readdir(outside)).sort()).toEqual(before);
      expect(await readFile(sentinel)).toEqual(sentinelBytes);
    });
  }

  it.runIf(platform() !== "win32")(
    "tightens an existing private transcription directory from 0755 to 0700",
    async () => {
      const { directory, model } = await fixture();
      const transcriptionRoot = join(
        directory,
        ".creatorcut-work",
        "transcription",
      );
      await mkdir(transcriptionRoot, { recursive: true, mode: 0o755 });
      await chmod(join(directory, ".creatorcut-work"), 0o755);
      await chmod(transcriptionRoot, 0o755);
      await transcribeProject({
        projectDirectory: directory,
        modelPath: model,
        languageMode: "auto",
        runner,
      });
      expect(
        (await stat(join(directory, ".creatorcut-work"))).mode & 0o777,
      ).toBe(0o700);
      expect((await stat(transcriptionRoot)).mode & 0o777).toBe(0o700);
    },
  );

  it("rejects a project-local symlink that resolves outside the project", async () => {
    const { directory, model } = await fixture();
    const source = join(directory, "media", "source.mov");
    const outside = join(directory, "..", "outside.mov");
    await writeFile(outside, "outside");
    await rm(source);
    await symlink(outside, source);

    await expect(
      transcribeProject({
        projectDirectory: directory,
        modelPath: model,
        languageMode: "auto",
        runner,
      }),
    ).rejects.toThrow(/escapes the project/u);
  });

  it("rejects transcription resume after the project revision changes", async () => {
    const { directory, model } = await fixture();
    const task = await transcribeProject({
      projectDirectory: directory,
      modelPath: model,
      languageMode: "mixed",
      runner,
    });
    expect(task.state).toBe("completed");

    const opened = await openCreatorCutProject(directory);
    await commitLocalRevision(directory, {
      baseRevision: opened.project.revision,
      nextTimeline: opened.timeline,
      operationIds: ["operation-after-transcription"],
    });

    await expect(resumeTranscriptionTask(directory)).rejects.toThrow(
      /stale for the current revision/u,
    );
  }, 15_000);

  it("does not let a slow worker overwrite cancellation or persist a transcript", async () => {
    const { directory, model } = await fixture();
    let releaseWhisper!: () => void;
    let whisperStarted!: () => void;
    const whisperReady = new Promise<void>((resolveReady) => {
      whisperStarted = resolveReady;
    });
    const release = new Promise<void>((resolveRelease) => {
      releaseWhisper = resolveRelease;
    });
    const slowRunner: ProcessRunner = async (command, args) => {
      if (command === "ffmpeg") {
        if (args.at(-1) !== "-") await writeFile(args.at(-1)!, "wav");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      whisperStarted();
      await release;
      const outputIndex = args.indexOf("-of");
      await writeFile(`${args[outputIndex + 1]!}.json`, JSON.stringify(raw));
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const worker = transcribeProject({
      projectDirectory: directory,
      modelPath: model,
      languageMode: "auto",
      runner: slowRunner,
    });
    await whisperReady;
    const cancelled = await cancelTranscriptionTask(directory);
    expect(cancelled.state).toBe("cancelled");
    releaseWhisper();

    await expect(worker).resolves.toMatchObject({
      task_id: cancelled.task_id,
      state: "cancelled",
    });
    expect(await readTranscriptionTask(directory)).toEqual(cancelled);
    expect(
      (await openCreatorCutProject(directory)).transcript.segments,
    ).toEqual([]);
  }, 15_000);

  it("does not let a late worker error rewrite an already cancelled task", async () => {
    const { directory, model } = await fixture();
    let releaseWhisper!: () => void;
    let whisperStarted!: () => void;
    const whisperReady = new Promise<void>((resolveReady) => {
      whisperStarted = resolveReady;
    });
    const release = new Promise<void>((resolveRelease) => {
      releaseWhisper = resolveRelease;
    });
    const failingRunner: ProcessRunner = async (command, args) => {
      if (command === "ffmpeg") {
        if (args.at(-1) !== "-") await writeFile(args.at(-1)!, "wav");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      whisperStarted();
      await release;
      return {
        exitCode: 1,
        stdout: "",
        stderr: "/Users/secret/private-model failed",
      };
    };
    const worker = transcribeProject({
      projectDirectory: directory,
      modelPath: model,
      languageMode: "auto",
      runner: failingRunner,
    });
    await whisperReady;
    const cancelled = await cancelTranscriptionTask(directory);
    releaseWhisper();

    await expect(worker).resolves.toEqual(cancelled);
    expect(await readTranscriptionTask(directory)).toEqual(cancelled);
    expect(
      JSON.stringify(await readTranscriptionTask(directory)),
    ).not.toContain("/Users/secret");
    expect(
      (await openCreatorCutProject(directory)).transcript.segments,
    ).toEqual([]);
  }, 15_000);
});
