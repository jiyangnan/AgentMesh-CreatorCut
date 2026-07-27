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
  has_video?: boolean;
  has_audio?: boolean;
}

export interface LocalMediaProject {
  schema_version: string;
  project_id: string;
  name: string;
  revision: number;
  assets: LocalMediaAsset[];
}

export interface LocalTimeline {
  schema_version: string;
  timeline_id: string;
  project_id: string;
  revision: number;
  duration_us: number;
  canvas: { width: number; height: number };
  tracks: Array<{
    track_id: string;
    kind: DirectorContext["timeline"]["tracks"][number]["kind"];
    clips: Array<{
      clip_id: string;
      asset_id: string;
      source_start_us: number;
      source_end_us: number;
      timeline_start_us: number;
      timeline_end_us: number;
    }>;
  }>;
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
    tokens: Array<{
      token_id: string;
      text: string;
      start_us: number;
      end_us: number;
      language: "zh" | "en" | "other";
      confidence: number;
    }>;
  }>;
  silence_intervals?: Array<{
    silence_id: string;
    source_asset_id: string;
    start_us: number;
    end_us: number;
  }>;
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
