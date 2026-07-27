export const CREATORCUT_OPERATIONS_VERSION = "1.0" as const;

export type CreatorCutOperationType =
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

export type CreatorCutOperationPrecondition =
  | {
      kind: "revision_equals";
      expected_revision: number;
    }
  | {
      kind: "clip_exists";
      clip_ref: string;
    }
  | {
      kind: "asset_exists";
      source_asset_ref: string;
    }
  | {
      kind: "range_within";
      track_ref: string;
      start_us: number;
      end_us: number;
    }
  | {
      kind: "clip_mapping_equals";
      clip_ref: string;
      source_asset_ref: string;
      source_start_us: number;
      source_end_us: number;
    };

export interface OperationParametersByType {
  trim: {
    clip_ref: string;
    source_start_us: number;
    source_end_us: number;
  };
  split: {
    clip_ref: string;
    at_timeline_us: number;
    left_clip_ref: string;
    right_clip_ref: string;
  };
  remove_range: {
    track_ref: string;
    clip_ref: string;
    timeline_start_us: number;
    timeline_end_us: number;
    ripple_all: boolean;
    source_asset_ref?: string;
    source_start_us?: number;
    source_end_us?: number;
    review_plan_ref?: string;
    suggestion_ref?: string;
    segment_refs?: string[];
    token_refs?: string[];
  };
  concat: {
    track_ref: string;
    clip_refs: string[];
  };
  set_gain: {
    track_ref: string;
    gain_millibels: number;
  };
  add_caption: {
    caption_ref: string;
    start_us: number;
    end_us: number;
    text: string;
    style_ref?: string;
  };
  set_canvas: {
    width: number;
    height: number;
  };
  apply_lut: {
    clip_ref: string;
    lut_asset_ref: string;
    intensity_millis: number;
  };
  move_clip: {
    clip_ref: string;
    track_ref: string;
    before_clip_ref?: string;
  };
  add_clip: {
    track_ref: string;
    clip_ref: string;
    source_asset_ref: string;
    source_start_us: number;
    source_end_us: number;
    timeline_start_us: number;
    timeline_end_us: number;
    gain_millibels?: number;
  };
  clear_track: {
    track_ref: string;
  };
  clear_captions: Record<string, never>;
  clear_lut: {
    clip_ref?: string;
  };
}

interface CreatorCutOperationCommon {
  schema_version: typeof CREATORCUT_OPERATIONS_VERSION;
  operation_id: string;
  base_revision: number;
  preconditions: CreatorCutOperationPrecondition[];
  inverse: {
    kind: "restore_snapshot";
    revision: number;
  };
  reason?: string;
}

export type CreatorCutWireOperation = {
  [Kind in CreatorCutOperationType]: CreatorCutOperationCommon & {
    operation_type: Kind;
    parameters: OperationParametersByType[Kind];
  };
}[CreatorCutOperationType];

export interface OperationsContractIssue {
  path: string;
  code: string;
  message: string;
}

export interface OperationsContractValidation {
  valid: boolean;
  value?: CreatorCutWireOperation;
  issues: OperationsContractIssue[];
}
