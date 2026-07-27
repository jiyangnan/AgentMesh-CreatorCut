import type {
  LocalTranscript,
  LocalTranscriptSilenceInterval,
} from "@agentmesh/creatorcut-runtime";
import type { MediaToolOptions } from "@agentmesh/creatorcut-media-engine";

export type LanguageMode = "zh" | "en" | "mixed" | "auto";

export interface RawWhisperToken {
  text?: string;
  timestamps?: { from?: string; to?: string };
  offsets?: { from?: number; to?: number };
  p?: number;
  probability?: number;
}

export interface RawWhisperSegment {
  text?: string;
  timestamps?: { from?: string; to?: string };
  offsets?: { from?: number; to?: number };
  tokens?: RawWhisperToken[];
}

export interface WhisperJson {
  result?: { language?: string };
  transcription?: RawWhisperSegment[];
}

export interface ParseWhisperContext {
  projectId: string;
  projectRevision: number;
  sourceAssetId: string;
  languageMode: LanguageMode;
}

export interface TranscriptionTask {
  schema_version: "creatorcut-transcription-task/1.0";
  task_id: string;
  project_id: string;
  base_revision: number;
  source_asset_id: string;
  source_sha256: string;
  model_sha256: string;
  language_mode: LanguageMode;
  glossary: string[];
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress_millis: number;
  completed_steps: string[];
  created_at: string;
  updated_at: string;
  error?: { code: string; message: string };
  result?: {
    transcript_id: string;
    detected_language: "zh" | "en" | "mixed" | "other";
    segment_count: number;
    token_count: number;
  };
}

export interface TranscriptionLocator {
  schema_version: "creatorcut-transcription-locator/1.0";
  source_path: string;
  model_path: string;
  whisper_path: string;
  ffmpeg_path: string;
  ffprobe_path: string;
}

export interface TranscribeProjectOptions extends MediaToolOptions {
  projectDirectory: string;
  modelPath: string;
  whisperPath?: string;
  languageMode: LanguageMode;
  glossary?: string[];
}

export interface Candidate {
  transcript: LocalTranscript;
  raw: WhisperJson;
  language: "auto" | "zh" | "en";
}

export type { LocalTranscript, LocalTranscriptSilenceInterval };
