export const DIRECTOR_PROTOCOL_VERSION = "1.0" as const;
export const PROJECT_PROTOCOL_VERSION = "1.0" as const;
export const OPERATION_PROTOCOL_VERSION = "1.0" as const;
export const HOST_CARD_PROTOCOL_VERSION = "1.0" as const;
export const ERROR_ENVELOPE_VERSION = "1.0" as const;
export const LIMITS_VERSION = "creatorcut-limits/1.0" as const;

export type ArtifactType =
  "decision_card_set" | "cost_quote" | "review_plan" | "edit_manifest";

export type ArtifactKeyStatus = "current" | "previous" | "revoked";

export interface SignatureBlock {
  algorithm: "Ed25519";
  key_id: string;
  value: string;
}

export interface DirectorEnvelope<TPayload = Record<string, unknown>> {
  envelope_version: typeof DIRECTOR_PROTOCOL_VERSION;
  artifact_type: ArtifactType;
  artifact_id: string;
  session_id: string;
  quote_id?: string;
  generation_id?: string;
  account_ref: string;
  project_id: string;
  sequence: number;
  previous_envelope_digest?: string;
  protocol_version: typeof DIRECTOR_PROTOCOL_VERSION;
  policy_version: string;
  base_revision: number;
  planning_input_digest: string;
  transcript_digest: string;
  timeline_digest: string;
  edit_brief_digest: string;
  answer_chain_digest: string;
  capabilities_digest: string;
  issued_at: string;
  expires_at?: string;
  payload: TPayload;
  signature: SignatureBlock;
}

export interface SignedArtifactKeyset {
  keyset_version: number;
  purpose: "director" | "release";
  issued_at: string;
  expires_at: string;
  keys: Array<{
    key_id: string;
    status: ArtifactKeyStatus;
    public_key_pem: string;
    not_before: string;
    not_after: string;
  }>;
  signature: SignatureBlock;
}

export interface DirectorContext {
  schema_version: typeof DIRECTOR_PROTOCOL_VERSION;
  project_id: string;
  base_revision: number;
  client_version: string;
  protocol_versions: string[];
  consent_version: string;
  project_digest: string;
  timeline_digest: string;
  transcript_digest: string;
  edit_brief_digest: string;
  capabilities_digest: string;
  transcript: {
    language_mode: "zh" | "en" | "mixed" | "auto";
    text_utf8_bytes: number;
    segment_count: number;
    token_count: number;
    segments: Array<{
      segment_id: string;
      start_us: number;
      end_us: number;
      text: string;
      tokens: Array<{
        token_id: string;
        start_us: number;
        end_us: number;
        text: string;
        language: "zh" | "en" | "other";
      }>;
    }>;
  };
  visual_event_summary?: VisualEventSummary;
}

export interface VisualEventSummary {
  schema_version: typeof DIRECTOR_PROTOCOL_VERSION;
  duration_us: number;
  width: number;
  height: number;
  scene_changes_us: number[];
  blank_intervals: Array<{ start_us: number; end_us: number }>;
  frozen_intervals: Array<{ start_us: number; end_us: number }>;
  cursor_activity: Array<{
    start_us: number;
    end_us: number;
    density_millis: number;
  }>;
  window_switches_us: number[];
}

export interface SemanticDecisionCardSet {
  schema_version: typeof HOST_CARD_PROTOCOL_VERSION;
  card_set_id: string;
  state_revision: number;
  stage:
    | "direction"
    | "look_and_sound"
    | "editing_review"
    | "execution_confirmation";
  cards: Array<{
    card_id: string;
    type: "single" | "multi" | "text" | "visual" | "voice" | "review";
    title: string;
    prompt: string;
    required: boolean;
    options?: Array<{
      option_id: string;
      label: string;
      description?: string;
      preview_ref?: string;
    }>;
    min_selections?: number;
    max_selections?: number;
  }>;
}

export interface CostQuote {
  schema_version: typeof DIRECTOR_PROTOCOL_VERSION;
  quote_id: string;
  action_code: "creatorcut.director.plan";
  cost: number;
  planning_input_digest: string;
  policy_version: string;
  expires_at: string;
}

export type EditOperationType =
  | "trim"
  | "split"
  | "remove_range"
  | "concat"
  | "set_gain"
  | "add_caption"
  | "set_canvas"
  | "apply_lut"
  | "move_clip"
  | "add_clip"
  | "clear_track"
  | "clear_captions"
  | "clear_lut";

export interface EditOperation {
  schema_version: typeof OPERATION_PROTOCOL_VERSION;
  operation_id: string;
  operation_type: EditOperationType;
  base_revision: number;
  preconditions: Array<Record<string, unknown>>;
  parameters: Record<string, unknown>;
  inverse: { kind: "restore_snapshot"; revision: number };
  reason?: string;
}

export interface EditReviewPlan {
  schema_version: typeof DIRECTOR_PROTOCOL_VERSION;
  review_plan_id: string;
  source_duration_us: number;
  estimated_duration_us: number;
  story_outline: string[];
  suggestions: Array<{
    suggestion_id: string;
    category:
      | "pause"
      | "filler"
      | "repeated_take"
      | "restart"
      | "weak_transition"
      | "off_topic";
    source_asset_ref: string;
    source_start_us: number;
    source_end_us: number;
    reason: string;
    risk: "low" | "medium" | "high";
    confidence_millis: number;
    default_decision: "accept" | "keep";
  }>;
}

export interface EditDecisionManifest {
  schema_version: typeof DIRECTOR_PROTOCOL_VERSION;
  manifest_id: string;
  review_plan_digest: string;
  final_decisions_digest: string;
  billing_receipt_ref: string;
  required_operation_types: EditOperationType[];
  operations: EditOperation[];
  summary: string;
}

export interface PublicClientCapabilities {
  schema_version: typeof DIRECTOR_PROTOCOL_VERSION;
  client_version: string;
  host_type: "codex" | "claude_code" | "openclaw" | "text";
  protocol_versions: string[];
  card_types: SemanticDecisionCardSet["cards"][number]["type"][];
  operation_types: EditOperationType[];
  supports_visual_previews: boolean;
  supports_voice_preview: boolean;
  max_payload_bytes: number;
}

export interface CreatorCutErrorEnvelope {
  error_version: typeof ERROR_ENVELOPE_VERSION;
  code:
    | "payload_too_large"
    | "resource_limit_exceeded"
    | "rate_limit_exceeded"
    | "protocol_version_unsupported"
    | "answer_conflict"
    | "generation_conflict"
    | "project_revision_conflict"
    | "signature_invalid";
  message: string;
  retryable: boolean;
  limits_version?: typeof LIMITS_VERSION;
  limit_id?: string;
  observed?: number;
  maximum?: number;
  retry_after_seconds?: number;
}
