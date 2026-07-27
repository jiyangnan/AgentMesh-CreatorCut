import type { MediaProbe, MediaToolOptions } from "./types.js";
import { runProcess } from "./process.js";

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  color_primaries?: string;
  color_transfer?: string;
  color_space?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
}

interface RawProbe {
  format?: { duration?: string };
  streams?: RawStream[];
}

function frameRate(value: string | undefined) {
  if (!value) return undefined;
  const [numeratorText, denominatorText] = value.split("/", 2);
  const numerator = Number.parseInt(numeratorText ?? "", 10);
  const denominator = Number.parseInt(denominatorText ?? "", 10);
  return numerator > 0 && denominator > 0
    ? { numerator, denominator }
    : undefined;
}

export async function probeMedia(
  path: string,
  options: MediaToolOptions = {},
): Promise<MediaProbe> {
  const runner = options.runner ?? runProcess;
  const result = await runner(
    options.ffprobePath ?? "ffprobe",
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", path],
    options.signal,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `CreatorCut could not probe local media: ${result.stderr.trim()}`,
    );
  }
  const raw = JSON.parse(result.stdout) as RawProbe;
  const video = raw.streams?.find((stream) => stream.codec_type === "video");
  const audio = raw.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number.parseFloat(raw.format?.duration ?? "");
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("CreatorCut media duration is invalid");
  }
  const rotation =
    video?.side_data_list?.find((entry) => Number.isFinite(entry.rotation))
      ?.rotation ?? Number.parseInt(video?.tags?.rotate ?? "0", 10);
  const normalizedRotation = Number.isFinite(rotation) ? rotation : 0;
  const rotatesCanvas = Math.abs(normalizedRotation) % 180 === 90;
  const rawWidth = video?.width ?? 0;
  const rawHeight = video?.height ?? 0;
  const parsedFrameRate = frameRate(video?.avg_frame_rate);
  return {
    duration_us: Math.round(duration * 1_000_000),
    width: rotatesCanvas ? rawHeight : rawWidth,
    height: rotatesCanvas ? rawWidth : rawHeight,
    ...(parsedFrameRate ? { frame_rate: parsedFrameRate } : {}),
    has_video: Boolean(video),
    has_audio: Boolean(audio),
    ...(video?.codec_name ? { video_codec: video.codec_name } : {}),
    ...(audio?.codec_name ? { audio_codec: audio.codec_name } : {}),
    ...(audio?.sample_rate
      ? { audio_sample_rate: Number.parseInt(audio.sample_rate, 10) }
      : {}),
    ...(audio?.channels ? { audio_channels: audio.channels } : {}),
    ...(normalizedRotation ? { rotation_degrees: normalizedRotation } : {}),
    ...(video?.color_primaries
      ? { color_primaries: video.color_primaries }
      : {}),
    ...(video?.color_transfer ? { color_transfer: video.color_transfer } : {}),
    ...(video?.color_space ? { color_space: video.color_space } : {}),
  };
}
