import type { EditOperation } from "@agentmesh/creatorcut-protocol";
import type {
  LocalMediaProject,
  LocalTimeline,
  OpenedCreatorCutProject,
} from "@agentmesh/creatorcut-runtime";

export interface MediaProbe {
  duration_us: number;
  width: number;
  height: number;
  frame_rate?: { numerator: number; denominator: number };
  has_video: boolean;
  has_audio: boolean;
  video_codec?: string;
  audio_codec?: string;
  audio_sample_rate?: number;
  audio_channels?: number;
  rotation_degrees?: number;
  color_primaries?: string;
  color_transfer?: string;
  color_space?: string;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (
  command: string,
  args: string[],
  signal?: AbortSignal,
) => Promise<ProcessResult>;

export interface MediaToolOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  runner?: ProcessRunner;
  signal?: AbortSignal;
}

export interface ImportMediaOptions extends MediaToolOptions {
  sourcePath: string;
  projectDirectory: string;
  projectName?: string;
  overwrite?: false;
}

export interface ImportMediaResult {
  schema_version: "creatorcut-media-import/1.0";
  project_directory: string;
  project_id: string;
  source_asset_id: string;
  source_sha256: string;
  proxy_relative_path: string;
  proxy_sha256: string;
  probe: MediaProbe;
}

export interface ApplyOperationsInput {
  project: LocalMediaProject;
  timeline: LocalTimeline;
  operations: EditOperation[];
}

export interface RenderTimelineOptions extends MediaToolOptions {
  projectDirectory: string;
  project: LocalMediaProject;
  timeline: LocalTimeline;
  outputPath: string;
  quality: "preview" | "export";
  overwrite?: boolean;
}

export interface RenderTimelineResult {
  schema_version: "creatorcut-render-result/1.0";
  output_path: string;
  output_sha256: string;
  duration_us: number;
  width: number;
  height: number;
  quality: "preview" | "export";
}

export interface PreviewRecord {
  schema_version: "creatorcut-preview-confirmation/1.0";
  project_id: string;
  base_revision: number;
  manifest_digest: string;
  planned_project_digest: string;
  planned_timeline_digest: string;
  planned_edit_brief_digest: string;
  preview_path: string;
  preview_sha256: string;
  confirmation_token: string;
  created_at: string;
}

export interface ApplyManifestResult {
  opened: OpenedCreatorCutProject;
  manifest_digest: string;
}
