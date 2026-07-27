import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCreatorCutProject,
  openCreatorCutProject,
} from "@agentmesh/creatorcut-runtime";
import type { ProcessRunner } from "@agentmesh/creatorcut-media-engine";
import { describe, expect, it } from "vitest";

import {
  detectTranscriptLanguage,
  parseSilence,
  parseWhisperJson,
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
  });
});
