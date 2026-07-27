import type {
  DirectorContext,
  PublicClientCapabilities,
} from "@agentmesh/creatorcut-protocol";

export interface LocalMediaAsset {
  asset_id: string;
  kind: "video" | "audio" | "image" | "subtitle" | "lut";
  relative_path: string;
  sha256: string;
  duration_us: number;
  width?: number;
  height?: number;
  frame_rate?: { numerator: number; denominator: number };
  has_video?: boolean;
  has_audio?: boolean;
  video_codec?: string;
  audio_codec?: string;
  audio_sample_rate?: number;
  audio_channels?: number;
  rotation_degrees?: number;
  color_primaries?: string;
  color_transfer?: string;
  color_space?: string;
}

export interface LocalMediaProject {
  schema_version: string;
  project_id: string;
  name: string;
  revision: number;
  created_at?: string;
  updated_at?: string;
  assets: LocalMediaAsset[];
}

export interface LocalTimelineClip {
  clip_id: string;
  asset_id: string;
  source_start_us: number;
  source_end_us: number;
  timeline_start_us: number;
  timeline_end_us: number;
  speed_numerator?: number;
  speed_denominator?: number;
  gain_millibels?: number;
}

export interface LocalTimelineTrack {
  track_id: string;
  kind: DirectorContext["timeline"]["tracks"][number]["kind"];
  clips: LocalTimelineClip[];
}

export interface LocalTimelineCaption {
  caption_id: string;
  start_us: number;
  end_us: number;
  text: string;
  style_id?: string;
}

export interface LocalTimelineEffect {
  effect_id: string;
  type: "lut";
  target_clip_id: string;
  lut_asset_id: string;
  intensity_millis: number;
}

export interface LocalTimeline {
  schema_version: string;
  timeline_id: string;
  project_id: string;
  revision: number;
  duration_us: number;
  timebase?: "microseconds";
  canvas: {
    width: number;
    height: number;
    framing?: {
      mode: "fit_blur" | "center_crop";
      focus_x_millis: number;
      focus_y_millis: number;
    };
  };
  caption_safe_area?: {
    left_px: number;
    right_px: number;
    top_px: number;
    bottom_px: number;
  };
  tracks: LocalTimelineTrack[];
  captions?: LocalTimelineCaption[];
  effects?: LocalTimelineEffect[];
}

export interface LocalTranscript {
  schema_version: string;
  transcript_id: string;
  project_id: string;
  revision: number;
  language_mode: DirectorContext["transcript"]["language_mode"];
  segments: Array<{
    segment_id: string;
    source_asset_id: string;
    start_us: number;
    end_us: number;
    display_text: string;
    tokens: LocalTranscriptToken[];
  }>;
  silence_intervals?: LocalTranscriptSilenceInterval[];
}

export interface LocalTranscriptToken {
  token_id: string;
  text: string;
  start_us: number;
  end_us: number;
  language: "zh" | "en" | "other";
  confidence: number;
}

export interface LocalTranscriptSilenceInterval {
  silence_id: string;
  source_asset_id: string;
  start_us: number;
  end_us: number;
}

export interface LocalEditBrief {
  schema_version: string;
  brief_id: string;
  project_id: string;
  base_revision: number;
  audio_mode: "original" | "partial_voiceover" | "full_voiceover";
  caption_style_id: string;
  approved: boolean;
  [key: string]: unknown;
}

export interface LocalProjectSnapshot {
  schema_version: "creatorcut-local-snapshot/1.0";
  revision: number;
  project: LocalMediaProject;
  timeline: LocalTimeline;
  transcript: LocalTranscript;
  edit_brief: LocalEditBrief;
}

export interface LocalRevisionHistory {
  schema_version: "creatorcut-local-history/1.0";
  current_revision: number;
  undo_stack: number[];
  redo_stack: number[];
}

export interface LocalOperationLogEntry {
  schema_version: "creatorcut-local-operation-log/1.0";
  revision: number;
  base_revision: number;
  operation_ids: string[];
  manifest_digest?: string;
  committed_at: string;
}

export interface CreateLocalProjectInput {
  project: LocalMediaProject;
  timeline: LocalTimeline;
  transcript?: LocalTranscript;
  editBrief?: LocalEditBrief;
}

export interface CommitLocalRevisionInput {
  baseRevision: number;
  nextTimeline: LocalTimeline;
  nextProject?: LocalMediaProject;
  nextEditBrief?: LocalEditBrief;
  operationIds: string[];
  manifestDigest?: string;
}

export interface OpenedCreatorCutProject {
  directory: string;
  creatorcutDirectory: string;
  project: LocalMediaProject;
  timeline: LocalTimeline;
  transcript: LocalTranscript;
  editBrief: LocalEditBrief;
}

export interface DirectorContextInspection {
  schema_version: "creatorcut-context-inspection/1.0";
  project_id: string;
  base_revision: number;
  planning_input_digest: string;
  upload_bytes: number;
  uploads_original_media: false;
  uploads_screenshots: false;
  uploads_absolute_paths: false;
  transcript: {
    language_mode: DirectorContext["transcript"]["language_mode"];
    segment_count: number;
    token_count: number;
    text_utf8_bytes: number;
  };
  fields: string[];
  context: DirectorContext;
}

export interface DirectorConsentRecord {
  schema_version: "creatorcut-director-consent/1.0";
  consent_version: string;
  project_id: string;
  base_revision: number;
  planning_input_digest: string;
  transcript_digest: string;
  upload_bytes: number;
  approved_at: string;
}

export interface BuildDirectorContextOptions {
  clientVersion?: string;
  consentVersion?: string;
  hostType?: PublicClientCapabilities["host_type"];
  projectKind?: DirectorContext["local_facts"]["project_kind"];
  voiceGenerationAvailable?: boolean;
  currentFinishing?: DirectorContext["local_facts"]["current_finishing"];
}
