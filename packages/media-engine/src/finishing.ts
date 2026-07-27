import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { EditFinishingIntent } from "@agentmesh/creatorcut-protocol";
import type {
  LocalEditBrief,
  LocalMediaAsset,
  LocalMediaProject,
  LocalTimeline,
  LocalTimelineCaption,
  LocalTranscript,
  OpenedCreatorCutProject,
} from "@agentmesh/creatorcut-runtime";

import {
  synthesizeLocalMusicBedWav,
  type LocalMusicTemplateId,
} from "./music-synth.js";

export interface MaterializedFinishing {
  project: LocalMediaProject;
  timeline: LocalTimeline;
  editBrief: LocalEditBrief;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assetWith(
  project: LocalMediaProject,
  asset: LocalMediaAsset,
): LocalMediaProject {
  return {
    ...project,
    assets: [
      ...project.assets.filter(
        (candidate) => candidate.asset_id !== asset.asset_id,
      ),
      asset,
    ],
  };
}

function joinCaptionText(left: string, right: string): string {
  if (!left) return right;
  const needsSpace = /[A-Za-z0-9]$/u.test(left) && /^[A-Za-z0-9]/u.test(right);
  return `${left}${needsSpace ? " " : ""}${right}`;
}

function captionsFromTranscript(
  transcript: LocalTranscript,
  timeline: LocalTimeline,
  styleId: "caption_clean" | "caption_bold",
): LocalTimelineCaption[] {
  const videoClips = timeline.tracks
    .filter((track) => track.kind === "video")
    .flatMap((track) => track.clips)
    .sort((left, right) => left.timeline_start_us - right.timeline_start_us);
  const mapped = transcript.segments
    .flatMap((segment) =>
      segment.tokens.map((token) => ({
        ...token,
        source_asset_id: segment.source_asset_id,
      })),
    )
    .flatMap((token) => {
      const clip = videoClips.find(
        (candidate) =>
          candidate.asset_id === token.source_asset_id &&
          candidate.source_start_us < token.end_us &&
          candidate.source_end_us > token.start_us,
      );
      if (!clip) return [];
      const sourceStart = Math.max(token.start_us, clip.source_start_us);
      const sourceEnd = Math.min(token.end_us, clip.source_end_us);
      if (sourceEnd - sourceStart < 80_000) return [];
      return [
        {
          text: token.text.trim(),
          start_us: clip.timeline_start_us + sourceStart - clip.source_start_us,
          end_us: clip.timeline_start_us + sourceEnd - clip.source_start_us,
        },
      ];
    })
    .filter((token) => token.text.length > 0)
    .sort((left, right) => left.start_us - right.start_us);

  const groups: Array<{ text: string; start_us: number; end_us: number }> = [];
  for (const token of mapped) {
    const current = groups.at(-1);
    const combined = current
      ? joinCaptionText(current.text, token.text)
      : token.text;
    if (
      current &&
      token.start_us - current.end_us <= 400_000 &&
      token.end_us - current.start_us <= 3_000_000 &&
      Array.from(combined).length <= (styleId === "caption_bold" ? 18 : 28)
    ) {
      current.text = combined;
      current.end_us = Math.max(current.end_us, token.end_us);
    } else {
      groups.push({ ...token });
    }
  }
  return groups.map((group, index) => ({
    caption_id: `caption_finishing_${String(index).padStart(4, "0")}`,
    start_us: group.start_us,
    end_us: Math.min(
      timeline.duration_us,
      Math.max(group.end_us, group.start_us + 500_000),
    ),
    text: group.text,
    style_id: styleId,
  }));
}

function lutCube(id: "lut_warm" | "lut_cool"): string {
  const transform =
    id === "lut_warm"
      ? ([red, green, blue]: [number, number, number]) => [
          Math.min(1, red * 1.03),
          green,
          blue * 0.94,
        ]
      : ([red, green, blue]: [number, number, number]) => [
          red * 0.96,
          Math.min(1, green * 1.01),
          Math.min(1, blue * 1.04),
        ];
  const values: string[] = [];
  for (const blue of [0, 1]) {
    for (const green of [0, 1]) {
      for (const red of [0, 1]) {
        values.push(transform([red, green, blue]).join(" "));
      }
    }
  }
  return `TITLE "${id}"\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n${values.join("\n")}\n`;
}

async function persistGenerated(
  opened: OpenedCreatorCutProject,
  name: string,
  bytes: Buffer | string,
): Promise<{ relativePath: string; digest: string }> {
  const relativePath = join(".creatorcut", "generated", name);
  const path = join(opened.directory, relativePath);
  await mkdir(join(opened.creatorcutDirectory, "generated"), {
    recursive: true,
    mode: 0o700,
  });
  const expected = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
  const existing = await readFile(path).catch(() => null);
  if (existing && !existing.equals(expected)) {
    throw new Error(`Generated finishing asset changed: ${name}`);
  }
  if (!existing) await writeFile(path, expected, { mode: 0o600 });
  return { relativePath, digest: sha256(expected) };
}

export async function materializeFinishing(
  opened: OpenedCreatorCutProject,
  baseTimeline: LocalTimeline,
  finishing: EditFinishingIntent | undefined,
  manifestDigest: string,
): Promise<MaterializedFinishing> {
  if (!finishing) {
    return {
      project: structuredClone(opened.project),
      timeline: structuredClone(baseTimeline),
      editBrief: structuredClone(opened.editBrief),
    };
  }
  if (finishing.voice_mode !== "original") {
    throw new Error(
      "This CreatorCut client cannot execute signed voiceover finishing",
    );
  }
  let project = structuredClone(opened.project);
  let timeline: LocalTimeline = {
    ...structuredClone(baseTimeline),
    captions:
      finishing.caption_style_id === "caption_none"
        ? []
        : captionsFromTranscript(
            opened.transcript,
            baseTimeline,
            finishing.caption_style_id,
          ),
    effects: [],
    tracks: baseTimeline.tracks.filter(
      (track) => track.kind !== "voiceover" && track.kind !== "music",
    ),
  };
  const shortDigest = manifestDigest.replace(/^sha256:/u, "").slice(0, 16);

  if (finishing.lut_id !== "lut_none") {
    const generated = await persistGenerated(
      opened,
      `lut-${finishing.lut_id}-${shortDigest}.cube`,
      lutCube(finishing.lut_id),
    );
    const lutAssetId = `asset_${finishing.lut_id}_${shortDigest}`;
    project = assetWith(project, {
      asset_id: lutAssetId,
      kind: "lut",
      relative_path: generated.relativePath,
      sha256: generated.digest,
      duration_us: 0,
    });
    timeline.effects = timeline.tracks
      .filter((track) => track.kind === "video")
      .flatMap((track) => track.clips)
      .map((clip) => ({
        effect_id: `effect_${finishing.lut_id}_${clip.clip_id}`,
        type: "lut" as const,
        target_clip_id: clip.clip_id,
        lut_asset_id: lutAssetId,
        intensity_millis: 1000,
      }));
  }

  if (finishing.background_music.mode === "local_template") {
    const templateId = finishing.background_music
      .template_id as LocalMusicTemplateId;
    const music = synthesizeLocalMusicBedWav(timeline.duration_us, templateId);
    const generated = await persistGenerated(
      opened,
      `music-${templateId}-${shortDigest}.wav`,
      music,
    );
    const musicAssetId = `asset_music_${templateId}_${shortDigest}`;
    project = assetWith(project, {
      asset_id: musicAssetId,
      kind: "audio",
      relative_path: generated.relativePath,
      sha256: generated.digest,
      duration_us: timeline.duration_us,
      has_video: false,
      has_audio: true,
      audio_codec: "pcm_s16le",
      audio_sample_rate: 48_000,
      audio_channels: 2,
    });
    timeline.tracks = [
      ...timeline.tracks,
      {
        track_id: `track_music_${templateId}`,
        kind: "music",
        clips: [
          {
            clip_id: `clip_music_${templateId}`,
            asset_id: musicAssetId,
            source_start_us: 0,
            source_end_us: timeline.duration_us,
            timeline_start_us: 0,
            timeline_end_us: timeline.duration_us,
            gain_millibels: 0,
          },
        ],
      },
    ];
  }

  return {
    project,
    timeline,
    editBrief: {
      ...structuredClone(opened.editBrief),
      audio_mode: finishing.voice_mode,
      caption_style_id: finishing.caption_style_id,
      lut_id: finishing.lut_id,
      background_music: finishing.background_music,
      approved: true,
    },
  };
}
