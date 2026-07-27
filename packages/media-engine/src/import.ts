import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import {
  createCreatorCutProject,
  writeLocalArtifact,
  type LocalMediaAsset,
  type LocalMediaProject,
  type LocalTimeline,
} from "@agentmesh/creatorcut-runtime";

import { runProcess } from "./process.js";
import { probeMedia } from "./probe.js";
import type { ImportMediaOptions, ImportMediaResult } from "./types.js";

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function safeExtension(path: string): string {
  const value = extname(path).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/u.test(value) ? value : ".media";
}

export async function importMedia(
  options: ImportMediaOptions,
): Promise<ImportMediaResult> {
  const source = await realpath(resolve(options.sourcePath));
  const sourceStat = await stat(source);
  if (!sourceStat.isFile())
    throw new TypeError("CreatorCut media source must be a file");
  const destination = resolve(options.projectDirectory);
  if (
    await access(destination)
      .then(() => true)
      .catch(() => false)
  ) {
    throw new Error("CreatorCut project destination already exists");
  }
  const probe = await probeMedia(source, options);
  if (!probe.has_video || probe.width <= 0 || probe.height <= 0) {
    throw new Error("CreatorCut M1 requires an FFmpeg-readable video stream");
  }
  const sourceSha256 = await sha256File(source);
  const projectId = `project_${sourceSha256.slice(0, 20)}`;
  const assetId = `asset_${sourceSha256.slice(0, 20)}`;
  const temporary = join(
    dirname(destination),
    `.creatorcut-import-${sourceSha256.slice(0, 8)}-${randomUUID()}`,
  );
  await mkdir(dirname(destination), { recursive: true });
  try {
    const timestamp = new Date().toISOString();
    const relativeSource = `media/source${safeExtension(source)}`;
    const asset: LocalMediaAsset = {
      asset_id: assetId,
      kind: "video",
      relative_path: relativeSource,
      sha256: sourceSha256,
      duration_us: probe.duration_us,
      width: probe.width,
      height: probe.height,
      has_video: true,
      has_audio: probe.has_audio,
      ...(probe.frame_rate ? { frame_rate: probe.frame_rate } : {}),
      ...(probe.video_codec ? { video_codec: probe.video_codec } : {}),
      ...(probe.audio_codec ? { audio_codec: probe.audio_codec } : {}),
      ...(probe.audio_sample_rate
        ? { audio_sample_rate: probe.audio_sample_rate }
        : {}),
      ...(probe.audio_channels ? { audio_channels: probe.audio_channels } : {}),
      ...(probe.rotation_degrees
        ? { rotation_degrees: probe.rotation_degrees }
        : {}),
      ...(probe.color_primaries
        ? { color_primaries: probe.color_primaries }
        : {}),
      ...(probe.color_transfer ? { color_transfer: probe.color_transfer } : {}),
      ...(probe.color_space ? { color_space: probe.color_space } : {}),
    };
    const project: LocalMediaProject = {
      schema_version: "1.0",
      project_id: projectId,
      name: options.projectName?.trim() || basename(source, extname(source)),
      revision: 0,
      created_at: timestamp,
      updated_at: timestamp,
      assets: [asset],
    };
    const timeline: LocalTimeline = {
      schema_version: "1.0",
      timeline_id: `timeline:${projectId}`,
      project_id: projectId,
      revision: 0,
      timebase: "microseconds",
      duration_us: probe.duration_us,
      canvas: {
        width: probe.width - (probe.width % 2),
        height: probe.height - (probe.height % 2),
        framing: {
          mode: "fit_blur",
          focus_x_millis: 500,
          focus_y_millis: 500,
        },
      },
      tracks: [
        {
          track_id: "track_video",
          kind: "video",
          clips: [
            {
              clip_id: "clip_source",
              asset_id: assetId,
              source_start_us: 0,
              source_end_us: probe.duration_us,
              timeline_start_us: 0,
              timeline_end_us: probe.duration_us,
            },
          ],
        },
        { track_id: "track_voiceover", kind: "voiceover", clips: [] },
        { track_id: "track_music", kind: "music", clips: [] },
      ],
      captions: [],
      effects: [],
    };
    await createCreatorCutProject(temporary, { project, timeline });
    const copiedSource = join(temporary, relativeSource);
    await copyFile(source, copiedSource);
    if ((await sha256File(copiedSource)) !== sourceSha256) {
      throw new Error("CreatorCut source copy digest mismatch");
    }
    const proxyRelativePath = "proxies/source-proxy.mp4";
    const proxyPath = join(temporary, proxyRelativePath);
    const runner = options.runner ?? runProcess;
    const proxy = await runner(
      options.ffmpegPath ?? "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        copiedSource,
        "-vf",
        "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease,setsar=1",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "25",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        proxyPath,
      ],
      options.signal,
    );
    if (proxy.exitCode !== 0) {
      throw new Error(
        `CreatorCut proxy generation failed: ${proxy.stderr.trim()}`,
      );
    }
    const proxyProbe = await probeMedia(proxyPath, options);
    if (!proxyProbe.has_video || proxyProbe.duration_us <= 0) {
      throw new Error("CreatorCut generated proxy is invalid");
    }
    const proxySha256 = await sha256File(proxyPath);
    await writeLocalArtifact(temporary, "tasks/import.json", {
      schema_version: "creatorcut-import-task/1.0",
      state: "completed",
      source_asset_id: assetId,
      source_sha256: sourceSha256,
      proxy_relative_path: proxyRelativePath,
      proxy_sha256: proxySha256,
      completed_at: new Date().toISOString(),
    });
    await rename(temporary, destination);
    return {
      schema_version: "creatorcut-media-import/1.0",
      project_directory: destination,
      project_id: projectId,
      source_asset_id: assetId,
      source_sha256: sourceSha256,
      proxy_relative_path: proxyRelativePath,
      proxy_sha256: proxySha256,
      probe,
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
