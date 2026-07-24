import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

import clientCapabilitiesSchema from "../schemas/client-capabilities.schema.json" with { type: "json" };
import costQuoteSchema from "../schemas/cost-quote.schema.json" with { type: "json" };
import decisionCardAnswerSetSchema from "../schemas/decision-card-answer-set.schema.json" with { type: "json" };
import decisionCardSetSchema from "../schemas/decision-card-set.schema.json" with { type: "json" };
import directorContextSchema from "../schemas/director-context.schema.json" with { type: "json" };
import directorEnvelopeSchema from "../schemas/director-envelope.schema.json" with { type: "json" };
import editDecisionManifestSchema from "../schemas/edit-decision-manifest.schema.json" with { type: "json" };
import editOperationSchema from "../schemas/edit-operation.schema.json" with { type: "json" };
import editReviewPlanSchema from "../schemas/edit-review-plan.schema.json" with { type: "json" };
import editReviewDecisionSetSchema from "../schemas/edit-review-decision-set.schema.json" with { type: "json" };
import errorEnvelopeSchema from "../schemas/error-envelope.schema.json" with { type: "json" };
import keysetSchema from "../schemas/keyset.schema.json" with { type: "json" };
import visualEventSummarySchema from "../schemas/visual-event-summary.schema.json" with { type: "json" };
import {
  digestJcs,
  envelopeSigningBytes,
  keysetSigningBytes,
  verifyEd25519,
} from "./canonical.js";
import {
  assertCardSetLimits,
  assertDirectorContextLimits,
  assertManifestLimits,
  assertRequestSize,
  ProtocolLimitError,
} from "./limits.js";
import { DIRECTOR_PROTOCOL_VERSION } from "./types.js";
import type {
  DirectorContext,
  DirectorEnvelope,
  DecisionCardAnswerSet,
  EditDecisionManifest,
  EditOperation,
  EditReviewPlan,
  EditReviewDecisionSet,
  SemanticDecisionCardSet,
  SignedArtifactKeyset,
  VisualEventSummary,
} from "./types.js";

export type PublicProtocolKind =
  | "visual-event-summary"
  | "director-context"
  | "decision-card-set"
  | "decision-card-answer-set"
  | "cost-quote"
  | "edit-review-plan"
  | "edit-review-decision-set"
  | "edit-operation"
  | "edit-decision-manifest"
  | "director-envelope"
  | "keyset"
  | "error-envelope"
  | "client-capabilities";

export interface PublicProtocolIssue {
  path: string;
  code: string;
  message: string;
}

export interface PublicProtocolValidation<T = unknown> {
  valid: boolean;
  value?: T;
  issues: PublicProtocolIssue[];
}

const schemas = [
  visualEventSummarySchema,
  directorContextSchema,
  decisionCardSetSchema,
  decisionCardAnswerSetSchema,
  costQuoteSchema,
  editReviewPlanSchema,
  editReviewDecisionSetSchema,
  editOperationSchema,
  editDecisionManifestSchema,
  directorEnvelopeSchema,
  keysetSchema,
  errorEnvelopeSchema,
  clientCapabilitiesSchema,
];

const schemaIds: Record<PublicProtocolKind, string> = {
  "visual-event-summary": visualEventSummarySchema.$id,
  "director-context": directorContextSchema.$id,
  "decision-card-set": decisionCardSetSchema.$id,
  "decision-card-answer-set": decisionCardAnswerSetSchema.$id,
  "cost-quote": costQuoteSchema.$id,
  "edit-review-plan": editReviewPlanSchema.$id,
  "edit-review-decision-set": editReviewDecisionSetSchema.$id,
  "edit-operation": editOperationSchema.$id,
  "edit-decision-manifest": editDecisionManifestSchema.$id,
  "director-envelope": directorEnvelopeSchema.$id,
  keyset: keysetSchema.$id,
  "error-envelope": errorEnvelopeSchema.$id,
  "client-capabilities": clientCapabilitiesSchema.$id,
};

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
});
for (const schema of schemas) {
  ajv.addSchema(schema);
}

function issue(
  path: string,
  code: string,
  message: string,
): PublicProtocolIssue {
  return { path, code, message };
}

function ajvIssues(
  errors: ErrorObject[] | null | undefined,
): PublicProtocolIssue[] {
  return (errors ?? []).map((error) =>
    issue(
      error.instancePath || "/",
      `schema.${error.keyword}`,
      error.message ?? "schema validation failed",
    ),
  );
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate];
}

function validateVisualSummary(
  summary: VisualEventSummary,
): PublicProtocolIssue[] {
  const issues: PublicProtocolIssue[] = [];
  const checkIntervals = (
    intervals: Array<{ start_us: number; end_us: number }>,
    path: string,
  ): void => {
    intervals.forEach((interval, index) => {
      if (
        interval.end_us <= interval.start_us ||
        interval.end_us > summary.duration_us
      ) {
        issues.push(
          issue(
            `${path}/${index}`,
            "semantic.invalid_interval",
            "visual event interval must increase and stay within duration",
          ),
        );
      }
    });
  };
  checkIntervals(summary.blank_intervals, "/blank_intervals");
  checkIntervals(summary.frozen_intervals, "/frozen_intervals");
  checkIntervals(summary.cursor_activity, "/cursor_activity");
  for (const [path, timestamps] of [
    ["/scene_changes_us", summary.scene_changes_us],
    ["/window_switches_us", summary.window_switches_us],
  ] as const) {
    if (timestamps.some((timestamp) => timestamp > summary.duration_us)) {
      issues.push(
        issue(
          path,
          "semantic.timestamp_out_of_range",
          "visual event timestamp exceeds duration",
        ),
      );
    }
  }
  return issues;
}

function validateDirectorContext(
  context: DirectorContext,
): PublicProtocolIssue[] {
  const issues: PublicProtocolIssue[] = [];
  const mediaDuration = context.media.duration_us;
  const tokenCount = context.transcript.segments.reduce(
    (sum, segment) => sum + segment.tokens.length,
    0,
  );
  const textBytes = Buffer.byteLength(
    context.transcript.segments.map((segment) => segment.text).join(""),
    "utf8",
  );
  if (context.transcript.segment_count !== context.transcript.segments.length) {
    issues.push(
      issue(
        "/transcript/segment_count",
        "semantic.segment_count_mismatch",
        "segment_count must match segments length",
      ),
    );
  }
  if (context.transcript.token_count !== tokenCount) {
    issues.push(
      issue(
        "/transcript/token_count",
        "semantic.token_count_mismatch",
        "token_count must match nested token count",
      ),
    );
  }
  if (context.transcript.text_utf8_bytes !== textBytes) {
    issues.push(
      issue(
        "/transcript/text_utf8_bytes",
        "semantic.text_byte_count_mismatch",
        "text_utf8_bytes must match concatenated segment text",
      ),
    );
  }
  for (const [path, expected, actual] of [
    ["/timeline_digest", context.timeline_digest, digestJcs(context.timeline)],
    [
      "/transcript_digest",
      context.transcript_digest,
      digestJcs(context.transcript),
    ],
    [
      "/capabilities_digest",
      context.capabilities_digest,
      digestJcs(context.capabilities),
    ],
  ] as const) {
    if (expected !== actual) {
      issues.push(
        issue(
          path,
          "semantic.digest_mismatch",
          "declared digest must match the uploaded structured fact",
        ),
      );
    }
  }
  if (context.client_version !== context.capabilities.client_version) {
    issues.push(
      issue(
        "/client_version",
        "semantic.client_version_mismatch",
        "context and capabilities client versions must match",
      ),
    );
  }
  if (
    !context.protocol_versions.includes(DIRECTOR_PROTOCOL_VERSION) ||
    !context.capabilities.protocol_versions.includes(DIRECTOR_PROTOCOL_VERSION)
  ) {
    issues.push(
      issue(
        "/protocol_versions",
        "semantic.protocol_version_missing",
        "Director Protocol v1 must be declared by context and capabilities",
      ),
    );
  }

  const trackRefs = context.timeline.tracks.map((track) => track.track_ref);
  for (const trackRef of duplicates(trackRefs)) {
    issues.push(
      issue(
        "/timeline/tracks",
        "semantic.duplicate_track_ref",
        `duplicate track_ref: ${trackRef}`,
      ),
    );
  }
  const clipRefs: string[] = [];
  context.timeline.tracks.forEach((track, trackIndex) => {
    track.clips.forEach((clip, clipIndex) => {
      clipRefs.push(clip.clip_ref);
      if (
        clip.source_asset_ref !== context.media.source_asset_ref ||
        clip.source_end_us <= clip.source_start_us ||
        clip.source_end_us > mediaDuration ||
        clip.timeline_end_us <= clip.timeline_start_us ||
        clip.timeline_end_us > context.timeline.duration_us ||
        clip.source_end_us - clip.source_start_us !==
          clip.timeline_end_us - clip.timeline_start_us
      ) {
        issues.push(
          issue(
            `/timeline/tracks/${trackIndex}/clips/${clipIndex}`,
            "semantic.invalid_timeline_mapping",
            "clip mapping must reference the uploaded asset, increase, stay in range, and preserve duration",
          ),
        );
      }
    });
  });
  for (const clipRef of duplicates(clipRefs)) {
    issues.push(
      issue(
        "/timeline/tracks",
        "semantic.duplicate_clip_ref",
        `duplicate clip_ref: ${clipRef}`,
      ),
    );
  }

  const segmentIds = context.transcript.segments.map(
    (segment) => segment.segment_id,
  );
  const tokenIds = context.transcript.segments.flatMap((segment) =>
    segment.tokens.map((token) => token.token_id),
  );
  for (const segmentId of duplicates(segmentIds)) {
    issues.push(
      issue(
        "/transcript/segments",
        "semantic.duplicate_segment_id",
        `duplicate segment_id: ${segmentId}`,
      ),
    );
  }
  for (const tokenId of duplicates(tokenIds)) {
    issues.push(
      issue(
        "/transcript/segments",
        "semantic.duplicate_token_id",
        `duplicate token_id: ${tokenId}`,
      ),
    );
  }
  context.transcript.segments.forEach((segment, segmentIndex) => {
    if (
      segment.source_asset_ref !== context.media.source_asset_ref ||
      segment.end_us <= segment.start_us ||
      segment.end_us > mediaDuration
    ) {
      issues.push(
        issue(
          `/transcript/segments/${segmentIndex}`,
          "semantic.invalid_segment_range",
          "segment must reference the uploaded asset and stay within duration",
        ),
      );
    }
    segment.tokens.forEach((token, tokenIndex) => {
      if (
        token.end_us <= token.start_us ||
        token.start_us < segment.start_us ||
        token.end_us > segment.end_us
      ) {
        issues.push(
          issue(
            `/transcript/segments/${segmentIndex}/tokens/${tokenIndex}`,
            "semantic.invalid_token_range",
            "token must increase and stay within its segment",
          ),
        );
      }
    });
  });
  context.transcript.silence_intervals.forEach((interval, index) => {
    if (
      interval.source_asset_ref !== context.media.source_asset_ref ||
      interval.end_us <= interval.start_us ||
      interval.end_us > mediaDuration
    ) {
      issues.push(
        issue(
          `/transcript/silence_intervals/${index}`,
          "semantic.invalid_silence_range",
          "silence interval must reference the uploaded asset and stay within duration",
        ),
      );
    }
  });
  if (
    context.visual_event_summary &&
    (context.visual_event_summary.duration_us !== mediaDuration ||
      context.visual_event_summary.width !== context.media.width ||
      context.visual_event_summary.height !== context.media.height)
  ) {
    issues.push(
      issue(
        "/visual_event_summary",
        "semantic.visual_media_mismatch",
        "visual summary dimensions and duration must match media facts",
      ),
    );
  }
  try {
    assertDirectorContextLimits(context);
  } catch (error) {
    if (error instanceof ProtocolLimitError) {
      issues.push(
        issue("/", error.code, `${error.limitId} exceeds public limit`),
      );
    } else {
      throw error;
    }
  }
  return issues;
}

function validateCardSet(
  cardSet: SemanticDecisionCardSet,
): PublicProtocolIssue[] {
  const issues: PublicProtocolIssue[] = [];
  for (const cardId of duplicates(cardSet.cards.map((card) => card.card_id))) {
    issues.push(
      issue(
        "/cards",
        "semantic.duplicate_card_id",
        `duplicate card_id: ${cardId}`,
      ),
    );
  }
  cardSet.cards.forEach((card, cardIndex) => {
    const optionIds = card.options?.map((option) => option.option_id) ?? [];
    for (const optionId of duplicates(optionIds)) {
      issues.push(
        issue(
          `/cards/${cardIndex}/options`,
          "semantic.duplicate_option_id",
          `duplicate option_id: ${optionId}`,
        ),
      );
    }
    if (
      ["single", "multi", "visual", "voice"].includes(card.type) &&
      optionIds.length === 0
    ) {
      issues.push(
        issue(
          `/cards/${cardIndex}/options`,
          "semantic.options_required",
          `${card.type} cards require at least one option`,
        ),
      );
    }
    if (
      card.min_selections !== undefined &&
      card.max_selections !== undefined &&
      card.min_selections > card.max_selections
    ) {
      issues.push(
        issue(
          `/cards/${cardIndex}`,
          "semantic.invalid_selection_range",
          "min_selections cannot exceed max_selections",
        ),
      );
    }
    const defaultOptionIds = card.default_option_ids ?? [];
    if (defaultOptionIds.some((optionId) => !optionIds.includes(optionId))) {
      issues.push(
        issue(
          `/cards/${cardIndex}/default_option_ids`,
          "semantic.unknown_default_option",
          "every default option must exist on the card",
        ),
      );
    }
    if (card.default_text !== undefined && card.type !== "text") {
      issues.push(
        issue(
          `/cards/${cardIndex}/default_text`,
          "semantic.default_type_mismatch",
          "default_text is only valid for text cards",
        ),
      );
    }
    if (card.default_approved !== undefined && card.type !== "review") {
      issues.push(
        issue(
          `/cards/${cardIndex}/default_approved`,
          "semantic.default_type_mismatch",
          "default_approved is only valid for review cards",
        ),
      );
    }
  });
  try {
    assertCardSetLimits(cardSet);
  } catch (error) {
    if (error instanceof ProtocolLimitError) {
      issues.push(
        issue("/", error.code, `${error.limitId} exceeds public limit`),
      );
    } else {
      throw error;
    }
  }
  return issues;
}

function validateCardAnswers(
  answerSet: DecisionCardAnswerSet,
): PublicProtocolIssue[] {
  const issues: PublicProtocolIssue[] = [];
  for (const cardId of duplicates(
    answerSet.answers.map((answer) => answer.card_id),
  )) {
    issues.push(
      issue(
        "/answers",
        "semantic.duplicate_card_answer",
        `duplicate answer for card_id: ${cardId}`,
      ),
    );
  }
  answerSet.answers.forEach((answer, index) => {
    const valueCount = [
      answer.selected_option_ids,
      answer.text_value,
      answer.approved,
    ].filter((value) => value !== undefined).length;
    if (valueCount !== 1) {
      issues.push(
        issue(
          `/answers/${index}`,
          "semantic.answer_value_count",
          "each card answer must contain exactly one value kind",
        ),
      );
    }
  });
  return issues;
}

function validateReviewDecisions(
  decisionSet: EditReviewDecisionSet,
): PublicProtocolIssue[] {
  const issues: PublicProtocolIssue[] = [];
  for (const suggestionId of duplicates(
    decisionSet.decisions.map((decision) => decision.suggestion_id),
  )) {
    issues.push(
      issue(
        "/decisions",
        "semantic.duplicate_suggestion_decision",
        `duplicate decision for suggestion_id: ${suggestionId}`,
      ),
    );
  }
  decisionSet.decisions.forEach((decision, index) => {
    const hasStart = decision.adjusted_source_start_us !== undefined;
    const hasEnd = decision.adjusted_source_end_us !== undefined;
    if (
      decision.decision === "modify" &&
      (!hasStart ||
        !hasEnd ||
        decision.adjusted_source_end_us! <= decision.adjusted_source_start_us!)
    ) {
      issues.push(
        issue(
          `/decisions/${index}`,
          "semantic.invalid_adjusted_range",
          "modified decisions require an increasing adjusted source range",
        ),
      );
    }
    if (decision.decision !== "modify" && (hasStart || hasEnd)) {
      issues.push(
        issue(
          `/decisions/${index}`,
          "semantic.unexpected_adjusted_range",
          "only modified decisions may include an adjusted source range",
        ),
      );
    }
  });
  return issues;
}

function validateReviewPlan(plan: EditReviewPlan): PublicProtocolIssue[] {
  const issues: PublicProtocolIssue[] = [];
  for (const suggestionId of duplicates(
    plan.suggestions.map((suggestion) => suggestion.suggestion_id),
  )) {
    issues.push(
      issue(
        "/suggestions",
        "semantic.duplicate_suggestion_id",
        `duplicate suggestion_id: ${suggestionId}`,
      ),
    );
  }
  plan.suggestions.forEach((suggestion, index) => {
    if (
      suggestion.source_end_us <= suggestion.source_start_us ||
      suggestion.source_end_us > plan.source_duration_us
    ) {
      issues.push(
        issue(
          `/suggestions/${index}`,
          "semantic.invalid_source_range",
          "suggestion range must increase and stay within source duration",
        ),
      );
    }
  });
  return issues;
}

const forbiddenOperationKeys = new Set([
  "absolute_path",
  "command",
  "executable",
  "script",
  "shell",
]);

function scanOperationValue(
  value: unknown,
  path: string,
): PublicProtocolIssue[] {
  if (typeof value === "string") {
    if (
      value.startsWith("/") ||
      value.startsWith("~/") ||
      /(^|[/\\])\.\.([/\\]|$)/u.test(value)
    ) {
      return [
        issue(
          path,
          "semantic.path_forbidden",
          "operations may reference stable asset IDs, not filesystem paths",
        ),
      ];
    }
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      scanOperationValue(entry, `${path}/${index}`),
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => {
      const keyIssues = forbiddenOperationKeys.has(key)
        ? [
            issue(
              `${path}/${key}`,
              "semantic.executable_field_forbidden",
              `operation field is forbidden: ${key}`,
            ),
          ]
        : [];
      return [...keyIssues, ...scanOperationValue(entry, `${path}/${key}`)];
    });
  }
  return [];
}

function validateOperation(operation: EditOperation): PublicProtocolIssue[] {
  return scanOperationValue(operation.parameters, "/parameters");
}

function validateManifest(
  manifest: EditDecisionManifest,
): PublicProtocolIssue[] {
  const issues: PublicProtocolIssue[] = [];
  for (const operationId of duplicates(
    manifest.operations.map((operation) => operation.operation_id),
  )) {
    issues.push(
      issue(
        "/operations",
        "semantic.duplicate_operation_id",
        `duplicate operation_id: ${operationId}`,
      ),
    );
  }
  const required = new Set(manifest.required_operation_types);
  manifest.operations.forEach((operation, index) => {
    if (!required.has(operation.operation_type)) {
      issues.push(
        issue(
          `/operations/${index}/operation_type`,
          "semantic.required_capability_missing",
          "operation type must be declared in required_operation_types",
        ),
      );
    }
    issues.push(
      ...validateOperation(operation).map((entry) => ({
        ...entry,
        path: `/operations/${index}${entry.path}`,
      })),
    );
  });
  try {
    assertManifestLimits(manifest);
  } catch (error) {
    if (error instanceof ProtocolLimitError) {
      issues.push(
        issue("/", error.code, `${error.limitId} exceeds public limit`),
      );
    } else {
      throw error;
    }
  }
  return issues;
}

function validateKeyset(keyset: SignedArtifactKeyset): PublicProtocolIssue[] {
  const issues: PublicProtocolIssue[] = [];
  for (const keyId of duplicates(keyset.keys.map((key) => key.key_id))) {
    issues.push(
      issue("/keys", "semantic.duplicate_key_id", `duplicate key_id: ${keyId}`),
    );
  }
  if (keyset.keys.filter((key) => key.status === "current").length !== 1) {
    issues.push(
      issue(
        "/keys",
        "semantic.current_key_count",
        "a keyset must contain exactly one current artifact key",
      ),
    );
  }
  keyset.keys.forEach((key, index) => {
    if (Date.parse(key.not_after) <= Date.parse(key.not_before)) {
      issues.push(
        issue(
          `/keys/${index}`,
          "semantic.invalid_key_window",
          "not_after must be later than not_before",
        ),
      );
    }
  });
  return issues;
}

function validateEnvelopePayload(
  envelope: DirectorEnvelope,
): PublicProtocolIssue[] {
  const payloadKinds: Record<
    DirectorEnvelope["artifact_type"],
    PublicProtocolKind
  > = {
    decision_card_set: "decision-card-set",
    cost_quote: "cost-quote",
    review_plan: "edit-review-plan",
    edit_manifest: "edit-decision-manifest",
  };
  const result = validatePublicProtocol(
    payloadKinds[envelope.artifact_type],
    envelope.payload,
  );
  const issues = result.issues.map((entry) => ({
    ...entry,
    path: `/payload${entry.path === "/" ? "" : entry.path}`,
  }));
  if (
    envelope.artifact_type === "cost_quote" &&
    (envelope.payload as { quote_id?: string }).quote_id !== envelope.quote_id
  ) {
    issues.push(
      issue(
        "/quote_id",
        "semantic.quote_id_mismatch",
        "envelope and payload quote IDs must match",
      ),
    );
  }
  return issues;
}

const semanticValidators: Partial<
  Record<PublicProtocolKind, (value: never) => PublicProtocolIssue[]>
> = {
  "visual-event-summary": validateVisualSummary as (
    value: never,
  ) => PublicProtocolIssue[],
  "director-context": validateDirectorContext as (
    value: never,
  ) => PublicProtocolIssue[],
  "decision-card-set": validateCardSet as (
    value: never,
  ) => PublicProtocolIssue[],
  "decision-card-answer-set": validateCardAnswers as (
    value: never,
  ) => PublicProtocolIssue[],
  "edit-review-plan": validateReviewPlan as (
    value: never,
  ) => PublicProtocolIssue[],
  "edit-review-decision-set": validateReviewDecisions as (
    value: never,
  ) => PublicProtocolIssue[],
  "edit-operation": validateOperation as (
    value: never,
  ) => PublicProtocolIssue[],
  "edit-decision-manifest": validateManifest as (
    value: never,
  ) => PublicProtocolIssue[],
  "director-envelope": validateEnvelopePayload as (
    value: never,
  ) => PublicProtocolIssue[],
  keyset: validateKeyset as (value: never) => PublicProtocolIssue[],
};

export function validatePublicProtocol<T = unknown>(
  kind: PublicProtocolKind,
  value: unknown,
): PublicProtocolValidation<T> {
  try {
    assertRequestSize(value);
  } catch (error) {
    if (error instanceof ProtocolLimitError) {
      return {
        valid: false,
        issues: [issue("/", error.code, error.message)],
      };
    }
    throw error;
  }

  const validator = ajv.getSchema(schemaIds[kind]);
  if (!validator) {
    throw new Error(`CreatorCut public schema failed to compile: ${kind}`);
  }
  if (!validator(value)) {
    return { valid: false, issues: ajvIssues(validator.errors) };
  }
  const semanticIssues = semanticValidators[kind]?.(value as never) ?? [];
  return semanticIssues.length === 0
    ? { valid: true, value: value as T, issues: [] }
    : { valid: false, issues: semanticIssues };
}

export function assertPublicProtocol<T = unknown>(
  kind: PublicProtocolKind,
  value: unknown,
): T {
  const result = validatePublicProtocol<T>(kind, value);
  if (!result.valid) {
    throw new TypeError(
      `Invalid CreatorCut ${kind}: ${result.issues
        .map((entry) => `${entry.path} ${entry.code}`)
        .join(", ")}`,
    );
  }
  return result.value as T;
}

export function verifySignedKeyset(
  keysetValue: unknown,
  trustedRecoveryRoots: ReadonlyMap<string, string>,
  options: {
    purpose: SignedArtifactKeyset["purpose"];
    minimumVersion?: number;
    now?: Date;
  },
): SignedArtifactKeyset {
  const keyset = assertPublicProtocol<SignedArtifactKeyset>(
    "keyset",
    keysetValue,
  );
  if (keyset.purpose !== options.purpose) {
    throw new TypeError("CreatorCut keyset purpose mismatch");
  }
  if (
    options.minimumVersion !== undefined &&
    keyset.keyset_version < options.minimumVersion
  ) {
    throw new TypeError("CreatorCut keyset rollback rejected");
  }
  const now = options.now ?? new Date();
  if (
    now.getTime() < Date.parse(keyset.issued_at) ||
    now.getTime() > Date.parse(keyset.expires_at)
  ) {
    throw new TypeError("CreatorCut keyset is outside its validity window");
  }
  const recoveryRoot = trustedRecoveryRoots.get(keyset.signature.key_id);
  if (!recoveryRoot) {
    throw new TypeError("Unknown CreatorCut recovery root");
  }
  if (
    !verifyEd25519(
      keysetSigningBytes(keyset),
      keyset.signature.value,
      recoveryRoot,
    )
  ) {
    throw new TypeError("Invalid CreatorCut keyset signature");
  }
  return keyset;
}

export function verifyDirectorEnvelope<T = Record<string, unknown>>(
  envelopeValue: unknown,
  verifiedKeyset: SignedArtifactKeyset,
  options: { now?: Date } = {},
): DirectorEnvelope<T> {
  if (verifiedKeyset.purpose !== "director") {
    throw new TypeError("A Director envelope requires a Director keyset");
  }
  const envelope = assertPublicProtocol<DirectorEnvelope<T>>(
    "director-envelope",
    envelopeValue,
  );
  const key = verifiedKeyset.keys.find(
    (candidate) => candidate.key_id === envelope.signature.key_id,
  );
  if (!key || key.status === "revoked") {
    throw new TypeError("Unknown or revoked CreatorCut Director key");
  }
  const issuedAt = Date.parse(envelope.issued_at);
  if (
    issuedAt < Date.parse(key.not_before) ||
    issuedAt > Date.parse(key.not_after)
  ) {
    throw new TypeError(
      "CreatorCut envelope was signed outside the key validity window",
    );
  }
  const now = options.now ?? new Date();
  if (
    envelope.artifact_type !== "edit_manifest" &&
    (envelope.expires_at === undefined ||
      now.getTime() > Date.parse(envelope.expires_at))
  ) {
    throw new TypeError("CreatorCut Director artifact is expired");
  }
  if (
    !verifyEd25519(
      envelopeSigningBytes(envelope),
      envelope.signature.value,
      key.public_key_pem,
    )
  ) {
    throw new TypeError("Invalid CreatorCut Director envelope signature");
  }
  return envelope;
}
