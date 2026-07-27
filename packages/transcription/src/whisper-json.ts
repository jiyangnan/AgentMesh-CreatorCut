import { createHash } from "node:crypto";

import type {
  LocalTranscript,
  LocalTranscriptToken,
} from "@agentmesh/creatorcut-runtime";

import type {
  ParseWhisperContext,
  RawWhisperSegment,
  RawWhisperToken,
  WhisperJson,
} from "./types.js";

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

function timestampUs(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/u.exec(value);
  if (!match) return null;
  return (
    (Number(match[1]) * 3_600_000 +
      Number(match[2]) * 60_000 +
      Number(match[3]) * 1_000 +
      Number(match[4])) *
    1_000
  );
}

function range(value: RawWhisperToken | RawWhisperSegment): {
  start: number;
  end: number;
} {
  return {
    start:
      timestampUs(value.timestamps?.from) ??
      Math.round((value.offsets?.from ?? 0) * 1_000),
    end:
      timestampUs(value.timestamps?.to) ??
      Math.round((value.offsets?.to ?? 0) * 1_000),
  };
}

function languageForText(
  text: string,
  fallback: LocalTranscriptToken["language"],
): LocalTranscriptToken["language"] {
  if (/\p{Script=Han}/u.test(text)) return "zh";
  if (/[A-Za-z0-9]/u.test(text)) return "en";
  return fallback;
}

function confidence(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value ?? 0)) : 0;
}

export function parseWhisperJson(
  raw: WhisperJson,
  context: ParseWhisperContext,
): LocalTranscript {
  const fallback: LocalTranscriptToken["language"] =
    raw.result?.language === "zh"
      ? "zh"
      : raw.result?.language === "en"
        ? "en"
        : "other";
  const segments = (raw.transcription ?? []).flatMap(
    (rawSegment, segmentIndex) => {
      const segmentRange = range(rawSegment);
      if (segmentRange.end <= segmentRange.start) return [];
      const rawText = rawSegment.text?.trim() ?? "";
      const tokens: LocalTranscriptToken[] = [];
      for (const [tokenIndex, rawToken] of (
        rawSegment.tokens ?? []
      ).entries()) {
        const text = rawToken.text ?? "";
        const tokenRange = range(rawToken);
        if (
          !text.trim() ||
          /^\[_.*\]$/u.test(text.trim()) ||
          tokenRange.end <= tokenRange.start
        ) {
          continue;
        }
        const start = Math.max(segmentRange.start, tokenRange.start);
        const end = Math.min(segmentRange.end, tokenRange.end);
        if (end <= start) continue;
        tokens.push({
          token_id: stableId(
            "token",
            `${context.sourceAssetId}:${segmentIndex}:${tokenIndex}:${start}:${end}:${text}`,
          ),
          text,
          start_us: start,
          end_us: end,
          language: languageForText(text, tokens.at(-1)?.language ?? fallback),
          confidence: confidence(rawToken.p ?? rawToken.probability),
        });
      }
      const corrupt = tokens.some((token) => token.text.includes("�"));
      if (tokens.length === 0 || corrupt) {
        tokens.splice(0, tokens.length, {
          token_id: stableId(
            "token",
            `${context.sourceAssetId}:${segmentIndex}:reconstructed:${rawText}`,
          ),
          text: rawText || "…",
          start_us: segmentRange.start,
          end_us: segmentRange.end,
          language: languageForText(rawText, fallback),
          confidence:
            tokens.length === 0
              ? 0
              : tokens.reduce((sum, token) => sum + token.confidence, 0) /
                tokens.length,
        });
      }
      const displayText =
        rawText ||
        tokens
          .map((token) => token.text)
          .join("")
          .trim();
      return [
        {
          segment_id: stableId(
            "segment",
            `${context.sourceAssetId}:${segmentIndex}:${segmentRange.start}:${segmentRange.end}:${displayText}`,
          ),
          source_asset_id: context.sourceAssetId,
          start_us: segmentRange.start,
          end_us: segmentRange.end,
          display_text: displayText,
          tokens,
        },
      ];
    },
  );
  return {
    schema_version: "1.0",
    transcript_id: stableId(
      "transcript",
      `${context.projectId}:${context.sourceAssetId}:${context.projectRevision}`,
    ),
    project_id: context.projectId,
    revision: context.projectRevision,
    language_mode: context.languageMode,
    segments,
  };
}

export function detectTranscriptLanguage(
  transcript: LocalTranscript,
): "zh" | "en" | "mixed" | "other" {
  const languages = new Set(
    transcript.segments
      .flatMap((segment) => segment.tokens)
      .map((token) => token.language),
  );
  if (languages.has("zh") && languages.has("en")) return "mixed";
  if (languages.has("zh")) return "zh";
  if (languages.has("en")) return "en";
  return "other";
}
