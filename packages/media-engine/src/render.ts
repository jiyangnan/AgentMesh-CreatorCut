import { randomUUID } from "node:crypto";
import { access, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type {
  LocalMediaAsset,
  LocalTimeline,
  LocalTimelineCaption,
  LocalTimelineClip,
} from "@agentmesh/creatorcut-runtime";

import { runProcess } from "./process.js";
import { probeMedia } from "./probe.js";
import { sha256File } from "./import.js";
import type { RenderTimelineOptions, RenderTimelineResult } from "./types.js";

function seconds(value: number): string {
  return (value / 1_000_000).toFixed(6).replace(/\.?0+$/u, "");
}

async function safeAssetPath(
  projectDirectory: string,
  asset: LocalMediaAsset,
): Promise<string> {
  const root = await realpath(resolve(projectDirectory));
  const path = resolve(root, asset.relative_path);
  const fromRoot = relative(root, path);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error(`Asset escapes the CreatorCut project: ${asset.asset_id}`);
  }
  const actual = await realpath(path);
  const actualFromRoot = relative(root, actual);
  if (actualFromRoot.startsWith("..") || isAbsolute(actualFromRoot)) {
    throw new Error(
      `Asset symlink escapes the CreatorCut project: ${asset.asset_id}`,
    );
  }
  return actual;
}

function filterPath(path: string): string {
  return path
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'")
    .replaceAll(",", "\\,");
}

function assTime(microseconds: number): string {
  const centiseconds = Math.round(microseconds / 10_000);
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const secondsValue = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secondsValue).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

function assText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}")
    .replaceAll("\r\n", "\\N")
    .replaceAll("\n", "\\N");
}

function subtitleDocument(
  timeline: LocalTimeline,
  captions: LocalTimelineCaption[],
): string {
  const portrait = timeline.canvas.height > timeline.canvas.width;
  const fontSize = Math.max(
    24,
    Math.round(timeline.canvas.height * (portrait ? 0.03 : 0.044)),
  );
  const margin = Math.max(
    24,
    timeline.caption_safe_area?.bottom_px ??
      Math.round(timeline.canvas.height * 0.09),
  );
  const events = captions
    .map(
      (caption) =>
        `Dialogue: 0,${assTime(caption.start_us)},${assTime(caption.end_us)},Default,,0,0,0,,${assText(caption.text)}`,
    )
    .join("\n");
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${timeline.canvas.width}
PlayResY: ${timeline.canvas.height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00101010,&H70000000,-1,0,0,0,100,100,0,0,1,3,1,2,60,60,${margin},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;
}

function sortedClips(
  timeline: LocalTimeline,
  kind: string,
): LocalTimelineClip[] {
  return [
    ...(timeline.tracks.find((track) => track.kind === kind)?.clips ?? []),
  ].sort((left, right) => left.timeline_start_us - right.timeline_start_us);
}

export async function renderTimeline(
  options: RenderTimelineOptions,
): Promise<RenderTimelineResult> {
  const output = resolve(options.outputPath);
  if (
    !options.overwrite &&
    (await access(output)
      .then(() => true)
      .catch(() => false))
  ) {
    throw new Error("CreatorCut will not overwrite an existing output");
  }
  await mkdir(dirname(output), { recursive: true });
  const videoClips = sortedClips(options.timeline, "video");
  if (videoClips.length === 0) {
    throw new Error("CreatorCut timeline has no video clips");
  }
  const voiceClips = sortedClips(options.timeline, "voiceover");
  const musicClips = sortedClips(options.timeline, "music");
  const allClips = [...videoClips, ...voiceClips, ...musicClips];
  const assetById = new Map(
    options.project.assets.map((asset) => [asset.asset_id, asset]),
  );
  const assetIds = [...new Set(allClips.map((clip) => clip.asset_id))];
  const assets = assetIds.map((assetId) => {
    const asset = assetById.get(assetId);
    if (!asset)
      throw new Error(`Timeline references unknown asset: ${assetId}`);
    return asset;
  });
  const inputByAsset = new Map(
    assets.map((asset, index) => [asset.asset_id, index]),
  );
  const lutAssets = (options.timeline.effects ?? []).map((effect) => {
    const asset = assetById.get(effect.lut_asset_id);
    if (!asset || asset.kind !== "lut") {
      throw new Error("CreatorCut LUT effect references an invalid asset");
    }
    return asset;
  });
  const pathsByAsset = new Map(
    await Promise.all(
      [...new Set([...assets, ...lutAssets])].map(
        async (asset) =>
          [
            asset.asset_id,
            await safeAssetPath(options.projectDirectory, asset),
          ] as const,
      ),
    ),
  );
  const existingOutput = await realpath(output).catch(() => null);
  if (existingOutput && [...pathsByAsset.values()].includes(existingOutput)) {
    throw new Error("CreatorCut export can never overwrite a project asset");
  }
  const args: string[] = ["-nostdin", "-hide_banner", "-loglevel", "error"];
  if (options.overwrite) args.push("-y");
  for (const asset of assets) {
    args.push("-i", pathsByAsset.get(asset.asset_id)!);
  }
  const filters: string[] = [];
  for (const [index, clip] of videoClips.entries()) {
    const input = inputByAsset.get(clip.asset_id);
    if (input === undefined) throw new Error("CreatorCut input map is invalid");
    const width = options.timeline.canvas.width;
    const height = options.timeline.canvas.height;
    const chain = [
      `trim=start=${seconds(clip.source_start_us)}:end=${seconds(clip.source_end_us)}`,
      "setpts=PTS-STARTPTS",
      "setsar=1",
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      "format=yuv420p",
    ];
    const lut = options.timeline.effects?.find(
      (effect) =>
        effect.type === "lut" && effect.target_clip_id === clip.clip_id,
    );
    const baseLabel =
      lut && lut.intensity_millis > 0 ? `vbase${index}` : `v${index}`;
    filters.push(`[${input}:v:0]${chain.join(",")}[${baseLabel}]`);
    if (lut && lut.intensity_millis > 0) {
      const asset = assetById.get(lut.lut_asset_id);
      if (!asset || asset.kind !== "lut") {
        throw new Error("CreatorCut LUT effect references an invalid asset");
      }
      const lutPath = filterPath(pathsByAsset.get(asset.asset_id)!);
      if (lut.intensity_millis === 1000) {
        filters.push(`[${baseLabel}]lut3d=file='${lutPath}'[v${index}]`);
      } else {
        const mix = (lut.intensity_millis / 1000).toFixed(3);
        filters.push(`[${baseLabel}]split=2[vorig${index}][vgrade${index}]`);
        filters.push(`[vgrade${index}]lut3d=file='${lutPath}'[vlut${index}]`);
        filters.push(
          `[vorig${index}][vlut${index}]blend=all_expr='A*(1-${mix})+B*${mix}'[v${index}]`,
        );
      }
    }
  }
  filters.push(
    videoClips.length === 1
      ? "[v0]null[vcat]"
      : `${videoClips.map((_, index) => `[v${index}]`).join("")}concat=n=${videoClips.length}:v=1:a=0[vcat]`,
  );

  for (const [index, clip] of videoClips.entries()) {
    const asset = assetById.get(clip.asset_id);
    const gain = ((clip.gain_millibels ?? 0) / 1000).toFixed(3);
    if (asset?.has_audio === false) {
      filters.push(
        `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${seconds(clip.timeline_end_us - clip.timeline_start_us)},asetpts=PTS-STARTPTS,volume=${gain}dB[a${index}]`,
      );
    } else {
      const input = inputByAsset.get(clip.asset_id);
      filters.push(
        `[${input}:a:0]atrim=start=${seconds(clip.source_start_us)}:end=${seconds(clip.source_end_us)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${gain}dB[a${index}]`,
      );
    }
  }
  filters.push(
    videoClips.length === 1
      ? "[a0]anull[aoriginal]"
      : `${videoClips.map((_, index) => `[a${index}]`).join("")}concat=n=${videoClips.length}:v=0:a=1[aoriginal]`,
  );

  let primaryAudio = "aoriginal";
  if (voiceClips.length > 0) {
    const expression = voiceClips
      .map(
        (clip) =>
          `between(t,${seconds(clip.timeline_start_us)},${seconds(clip.timeline_end_us)})`,
      )
      .join("+");
    filters.push(`[aoriginal]volume=0.25:enable='${expression}'[aducked]`);
    for (const [index, clip] of voiceClips.entries()) {
      const input = inputByAsset.get(clip.asset_id);
      const delay = Math.round(clip.timeline_start_us / 1000);
      const gain = ((clip.gain_millibels ?? 0) / 1000).toFixed(3);
      filters.push(
        `[${input}:a:0]atrim=start=${seconds(clip.source_start_us)}:end=${seconds(clip.source_end_us)},asetpts=PTS-STARTPTS,aresample=48000,adelay=${delay}:all=1,apad,atrim=duration=${seconds(options.timeline.duration_us)},volume=${gain}dB[voice${index}]`,
      );
    }
    filters.push(
      `[aducked]${voiceClips.map((_, index) => `[voice${index}]`).join("")}amix=inputs=${voiceClips.length + 1}:duration=first:normalize=0[aprimary]`,
    );
    primaryAudio = "aprimary";
  }
  if (musicClips.length > 0) {
    for (const [index, clip] of musicClips.entries()) {
      const input = inputByAsset.get(clip.asset_id);
      const delay = Math.round(clip.timeline_start_us / 1000);
      const gain = ((clip.gain_millibels ?? -18_000) / 1000).toFixed(3);
      filters.push(
        `[${input}:a:0]atrim=start=${seconds(clip.source_start_us)}:end=${seconds(clip.source_end_us)},asetpts=PTS-STARTPTS,aresample=48000,adelay=${delay}:all=1,apad,atrim=duration=${seconds(options.timeline.duration_us)},volume=${gain}dB[music${index}]`,
      );
    }
    filters.push(
      `[${primaryAudio}]${musicClips.map((_, index) => `[music${index}]`).join("")}amix=inputs=${musicClips.length + 1}:duration=first:normalize=0[aout]`,
    );
  } else {
    filters.push(`[${primaryAudio}]anull[aout]`);
  }

  let subtitleFile: string | undefined;
  if ((options.timeline.captions?.length ?? 0) > 0) {
    subtitleFile = resolve(
      options.projectDirectory,
      ".creatorcut",
      "generated",
      `captions-${randomUUID()}.ass`,
    );
    await mkdir(dirname(subtitleFile), { recursive: true });
    await writeFile(
      subtitleFile,
      subtitleDocument(options.timeline, options.timeline.captions ?? []),
      { encoding: "utf8", mode: 0o600 },
    );
    filters.push(
      `[vcat]subtitles=filename='${filterPath(subtitleFile)}'[vout]`,
    );
  } else {
    filters.push("[vcat]null[vout]");
  }

  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    options.quality === "preview" ? "veryfast" : "medium",
    "-crf",
    options.quality === "preview" ? "27" : "18",
    "-c:a",
    "aac",
    "-b:a",
    options.quality === "preview" ? "128k" : "192k",
    "-movflags",
    "+faststart",
    output,
  );
  try {
    const result = await (options.runner ?? runProcess)(
      options.ffmpegPath ?? "ffmpeg",
      args,
      options.signal,
    );
    if (result.exitCode !== 0) {
      throw new Error(`CreatorCut render failed: ${result.stderr.trim()}`);
    }
    const probe = await probeMedia(output, options);
    if (!probe.has_video || probe.duration_us <= 0) {
      throw new Error("CreatorCut rendered output failed validation");
    }
    return {
      schema_version: "creatorcut-render-result/1.0",
      output_path: output,
      output_sha256: await sha256File(output),
      duration_us: probe.duration_us,
      width: probe.width,
      height: probe.height,
      quality: options.quality,
    };
  } finally {
    if (subtitleFile) await rm(subtitleFile, { force: true });
  }
}
