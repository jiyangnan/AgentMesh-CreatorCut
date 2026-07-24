import { LIMITS_VERSION } from "./types.js";

export const CREATORCUT_LIMITS_V1 = Object.freeze({
  limits_version: LIMITS_VERSION,
  request_json_bytes: 4 * 1024 * 1024,
  response_json_bytes: 2 * 1024 * 1024,
  transcript_utf8_bytes: 1_572_864,
  transcript_segments: 50_000,
  transcript_tokens: 250_000,
  session_card_sets: 32,
  cards_per_set: 12,
  options_per_card: 16,
  short_label_bytes: 512,
  long_text_bytes: 8 * 1024,
  manifest_operations: 2_000,
  captions: 10_000,
  assets: 256,
  tracks: 64,
  clips: 2_000,
  ffmpeg_argv_bytes: 64 * 1024,
  local_preview_soft_timeout_seconds: 60,
  sessions_per_account_per_day: 20,
  active_sessions_per_account: 5,
  active_generations_per_account: 2,
  answers_per_account_per_minute: 60,
  quotes_per_account_per_day: 20,
} as const);

export type CreatorCutLimitId = Exclude<
  keyof typeof CREATORCUT_LIMITS_V1,
  "limits_version"
>;

export class ProtocolLimitError extends Error {
  readonly code:
    "payload_too_large" | "resource_limit_exceeded" | "rate_limit_exceeded";

  constructor(
    code: ProtocolLimitError["code"],
    readonly limitId: CreatorCutLimitId,
    readonly observed: number,
    readonly maximum: number,
  ) {
    super(`${limitId} observed ${observed}, maximum ${maximum}`);
    this.name = "ProtocolLimitError";
    this.code = code;
  }
}

function assertMaximum(
  limitId: CreatorCutLimitId,
  observed: number,
  code: ProtocolLimitError["code"] = "resource_limit_exceeded",
): void {
  const maximum = CREATORCUT_LIMITS_V1[limitId];
  if (typeof maximum !== "number") {
    throw new TypeError(`non-numeric CreatorCut limit: ${limitId}`);
  }
  if (observed > maximum) {
    throw new ProtocolLimitError(code, limitId, observed, maximum);
  }
}

export function assertRequestSize(value: unknown): void {
  assertMaximum(
    "request_json_bytes",
    Buffer.byteLength(JSON.stringify(value), "utf8"),
    "payload_too_large",
  );
}

export function assertCardSetLimits(value: {
  cards: Array<{ options?: unknown[] }>;
}): void {
  assertMaximum("cards_per_set", value.cards.length);
  for (const card of value.cards) {
    assertMaximum("options_per_card", card.options?.length ?? 0);
  }
}

export function assertManifestLimits(value: { operations: unknown[] }): void {
  assertMaximum("manifest_operations", value.operations.length);
}

export function assertDirectorContextLimits(value: {
  transcript: {
    text_utf8_bytes: number;
    segments: Array<{ tokens: unknown[] }>;
  };
}): void {
  assertMaximum("transcript_utf8_bytes", value.transcript.text_utf8_bytes);
  assertMaximum("transcript_segments", value.transcript.segments.length);
  assertMaximum(
    "transcript_tokens",
    value.transcript.segments.reduce(
      (sum, segment) => sum + segment.tokens.length,
      0,
    ),
  );
}
