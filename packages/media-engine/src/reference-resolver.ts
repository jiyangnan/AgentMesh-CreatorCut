import { createHash } from "node:crypto";

import {
  assertCreatorCutOperation,
  CREATORCUT_OPERATIONS_VERSION,
  type CreatorCutOperationPrecondition,
  type CreatorCutWireOperation,
} from "@agentmesh/creatorcut-operations-contract";
import type { EditOperation } from "@agentmesh/creatorcut-protocol";
import {
  localAssetWireRef,
  localClipWireRef,
  localTrackWireRef,
  type LocalMediaProject,
  type LocalTimeline,
  type LocalTimelineClip,
} from "@agentmesh/creatorcut-runtime";

type ReferenceKind = "asset" | "track" | "clip" | "caption";

interface ReferenceState {
  base: {
    asset: Map<string, string>;
    track: Map<string, string>;
    clip: Map<string, string>;
  };
  execution: {
    clip: Map<string, string>;
    caption: Map<string, string>;
  };
  baseClipTrack: Map<string, string>;
  baseClipAsset: Map<string, string>;
  globalKinds: Map<string, ReferenceKind>;
}

function referenceError(message: string): never {
  throw new Error(`Cannot resolve creatorcut-operations/1.0 refs: ${message}`);
}

function addReference(
  state: ReferenceState,
  kind: "asset" | "track" | "clip",
  ref: string,
  localId: string,
): void {
  const existingKind = state.globalKinds.get(ref);
  if (existingKind && existingKind !== kind) {
    referenceError(
      `ref ${ref} is reused across ${existingKind} and ${kind} objects`,
    );
  }
  const existingId = state.base[kind].get(ref);
  if (existingId && existingId !== localId) {
    referenceError(`ref ${ref} maps to more than one ${kind}`);
  }
  state.globalKinds.set(ref, kind);
  state.base[kind].set(ref, localId);
}

function buildReferenceState(
  project: LocalMediaProject,
  timeline: LocalTimeline,
): ReferenceState {
  const state: ReferenceState = {
    base: {
      asset: new Map(),
      track: new Map(),
      clip: new Map(),
    },
    execution: {
      clip: new Map(),
      caption: new Map(),
    },
    baseClipTrack: new Map(),
    baseClipAsset: new Map(),
    globalKinds: new Map(),
  };
  for (const asset of project.assets) {
    addReference(state, "asset", localAssetWireRef(asset), asset.asset_id);
  }
  for (const track of timeline.tracks) {
    addReference(state, "track", localTrackWireRef(track), track.track_id);
    for (const clip of track.clips) {
      const clipRef = localClipWireRef(clip);
      addReference(state, "clip", clipRef, clip.clip_id);
      state.baseClipTrack.set(clipRef, track.track_id);
      state.baseClipAsset.set(clipRef, clip.asset_id);
    }
  }
  return state;
}

function resolveReference(
  state: ReferenceState,
  kind: "asset" | "track" | "clip",
  ref: string,
): string {
  const output = kind === "clip" ? state.execution.clip.get(ref) : undefined;
  const localId = output ?? state.base[kind].get(ref);
  if (!localId) referenceError(`unresolved ${kind}_ref: ${ref}`);
  return localId;
}

function resolveBaseReference(
  state: ReferenceState,
  kind: "asset" | "track" | "clip",
  ref: string,
): string {
  const localId = state.base[kind].get(ref);
  if (!localId) referenceError(`unresolved base ${kind}_ref: ${ref}`);
  return localId;
}

function baseClipByRef(
  timeline: LocalTimeline,
  state: ReferenceState,
  ref: string,
): LocalTimelineClip {
  const localId = resolveBaseReference(state, "clip", ref);
  for (const track of timeline.tracks) {
    const clip = track.clips.find((candidate) => candidate.clip_id === localId);
    if (clip) return clip;
  }
  return referenceError(`base clip_ref ${ref} has no local clip`);
}

function assertBasePrecondition(
  project: LocalMediaProject,
  timeline: LocalTimeline,
  state: ReferenceState,
  precondition: CreatorCutOperationPrecondition,
): void {
  switch (precondition.kind) {
    case "revision_equals":
      if (precondition.expected_revision !== timeline.revision) {
        referenceError("revision_equals does not match the base snapshot");
      }
      return;
    case "clip_exists":
      resolveBaseReference(state, "clip", precondition.clip_ref);
      return;
    case "asset_exists":
      resolveReference(state, "asset", precondition.source_asset_ref);
      return;
    case "range_within":
      resolveReference(state, "track", precondition.track_ref);
      if (
        precondition.start_us < 0 ||
        precondition.end_us <= precondition.start_us ||
        precondition.end_us > timeline.duration_us
      ) {
        referenceError("range_within is outside the base timeline");
      }
      return;
    case "clip_mapping_equals": {
      const clip = baseClipByRef(timeline, state, precondition.clip_ref);
      const assetId = resolveReference(
        state,
        "asset",
        precondition.source_asset_ref,
      );
      if (
        clip.asset_id !== assetId ||
        clip.source_start_us !== precondition.source_start_us ||
        clip.source_end_us !== precondition.source_end_us
      ) {
        referenceError("clip_mapping_equals does not match the base snapshot");
      }
      if (!project.assets.some((asset) => asset.asset_id === assetId)) {
        referenceError("clip_mapping_equals references a missing asset");
      }
      return;
    }
  }
}

function outputLocalId(
  operationId: string,
  outputRef: string,
  kind: "clip" | "caption",
): string {
  const digest = createHash("sha256")
    .update(
      `${CREATORCUT_OPERATIONS_VERSION}\0${operationId}\0${outputRef}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 24);
  return `${kind}:wire:${digest}`;
}

function reserveOutput(
  state: ReferenceState,
  kind: "clip" | "caption",
  operationId: string,
  ref: string,
): string {
  if (state.globalKinds.has(ref) || state.execution[kind].has(ref)) {
    referenceError(`output ${kind}_ref already exists: ${ref}`);
  }
  const localId = outputLocalId(operationId, ref, kind);
  if (
    [
      ...state.base.asset.values(),
      ...state.base.track.values(),
      ...state.base.clip.values(),
      ...state.execution.clip.values(),
      ...state.execution.caption.values(),
    ].includes(localId)
  ) {
    referenceError(`derived output local ID collides for ${ref}`);
  }
  state.globalKinds.set(ref, kind);
  state.execution[kind].set(ref, localId);
  return localId;
}

function localOperation(
  operation: CreatorCutWireOperation,
  state: ReferenceState,
): EditOperation {
  const common = {
    schema_version: operation.schema_version,
    operation_id: operation.operation_id,
    operation_type: operation.operation_type,
    base_revision: operation.base_revision,
    preconditions: [],
    inverse: operation.inverse,
    ...(operation.reason === undefined ? {} : { reason: operation.reason }),
  };
  switch (operation.operation_type) {
    case "trim":
      return {
        ...common,
        parameters: {
          clip_id: resolveReference(
            state,
            "clip",
            operation.parameters.clip_ref,
          ),
          source_start_us: operation.parameters.source_start_us,
          source_end_us: operation.parameters.source_end_us,
        },
      };
    case "split":
      return {
        ...common,
        parameters: {
          clip_id: resolveReference(
            state,
            "clip",
            operation.parameters.clip_ref,
          ),
          at_timeline_us: operation.parameters.at_timeline_us,
          left_clip_id: reserveOutput(
            state,
            "clip",
            operation.operation_id,
            operation.parameters.left_clip_ref,
          ),
          right_clip_id: reserveOutput(
            state,
            "clip",
            operation.operation_id,
            operation.parameters.right_clip_ref,
          ),
        },
      };
    case "remove_range":
      resolveBaseReference(state, "clip", operation.parameters.clip_ref);
      if (
        state.baseClipTrack.get(operation.parameters.clip_ref) !==
        resolveBaseReference(state, "track", operation.parameters.track_ref)
      ) {
        referenceError(
          "remove_range clip_ref is not anchored to the selected track_ref",
        );
      }
      if (operation.parameters.source_asset_ref) {
        const assetId = resolveBaseReference(
          state,
          "asset",
          operation.parameters.source_asset_ref,
        );
        if (
          state.baseClipAsset.get(operation.parameters.clip_ref) !== assetId
        ) {
          referenceError(
            "remove_range source_asset_ref does not match the anchor clip_ref",
          );
        }
      }
      return {
        ...common,
        parameters: {
          track_id: resolveBaseReference(
            state,
            "track",
            operation.parameters.track_ref,
          ),
          timeline_start_us: operation.parameters.timeline_start_us,
          timeline_end_us: operation.parameters.timeline_end_us,
          ripple_all: operation.parameters.ripple_all,
        },
      };
    case "concat":
      return {
        ...common,
        parameters: {
          track_id: resolveReference(
            state,
            "track",
            operation.parameters.track_ref,
          ),
          clip_ids: operation.parameters.clip_refs.map((ref) =>
            resolveReference(state, "clip", ref),
          ),
        },
      };
    case "set_gain":
      return {
        ...common,
        parameters: {
          track_id: resolveReference(
            state,
            "track",
            operation.parameters.track_ref,
          ),
          gain_millibels: operation.parameters.gain_millibels,
        },
      };
    case "add_caption":
      return {
        ...common,
        parameters: {
          caption_id: reserveOutput(
            state,
            "caption",
            operation.operation_id,
            operation.parameters.caption_ref,
          ),
          start_us: operation.parameters.start_us,
          end_us: operation.parameters.end_us,
          text: operation.parameters.text,
          ...(operation.parameters.style_ref
            ? { style_id: operation.parameters.style_ref }
            : {}),
        },
      };
    case "set_canvas":
      return { ...common, parameters: operation.parameters };
    case "apply_lut":
      return {
        ...common,
        parameters: {
          clip_id: resolveReference(
            state,
            "clip",
            operation.parameters.clip_ref,
          ),
          lut_asset_id: resolveReference(
            state,
            "asset",
            operation.parameters.lut_asset_ref,
          ),
          intensity_millis: operation.parameters.intensity_millis,
        },
      };
    case "move_clip":
      return {
        ...common,
        parameters: {
          clip_id: resolveReference(
            state,
            "clip",
            operation.parameters.clip_ref,
          ),
          track_id: resolveReference(
            state,
            "track",
            operation.parameters.track_ref,
          ),
          ...(operation.parameters.before_clip_ref
            ? {
                before_clip_id: resolveReference(
                  state,
                  "clip",
                  operation.parameters.before_clip_ref,
                ),
              }
            : {}),
        },
      };
    case "add_clip":
      return {
        ...common,
        parameters: {
          track_id: resolveReference(
            state,
            "track",
            operation.parameters.track_ref,
          ),
          clip_id: reserveOutput(
            state,
            "clip",
            operation.operation_id,
            operation.parameters.clip_ref,
          ),
          asset_id: resolveReference(
            state,
            "asset",
            operation.parameters.source_asset_ref,
          ),
          source_start_us: operation.parameters.source_start_us,
          source_end_us: operation.parameters.source_end_us,
          timeline_start_us: operation.parameters.timeline_start_us,
          timeline_end_us: operation.parameters.timeline_end_us,
          ...(operation.parameters.gain_millibels === undefined
            ? {}
            : { gain_millibels: operation.parameters.gain_millibels }),
        },
      };
    case "clear_track":
      return {
        ...common,
        parameters: {
          track_id: resolveReference(
            state,
            "track",
            operation.parameters.track_ref,
          ),
        },
      };
    case "clear_captions":
      return { ...common, parameters: {} };
    case "clear_lut":
      return {
        ...common,
        parameters: operation.parameters.clip_ref
          ? {
              clip_id: resolveReference(
                state,
                "clip",
                operation.parameters.clip_ref,
              ),
            }
          : {},
      };
  }
}

export interface CreatorCutOperationResolver {
  resolve(raw: unknown): EditOperation;
}

export function createCreatorCutOperationResolver(
  project: LocalMediaProject,
  timeline: LocalTimeline,
): CreatorCutOperationResolver {
  if (
    project.project_id !== timeline.project_id ||
    project.revision !== timeline.revision
  ) {
    referenceError("project and timeline base snapshot differ");
  }
  const state = buildReferenceState(project, timeline);
  return {
    resolve(raw: unknown): EditOperation {
      const operation = assertCreatorCutOperation(raw);
      if (
        operation.base_revision !== project.revision ||
        operation.inverse.revision !== operation.base_revision
      ) {
        referenceError("operation revision does not match the base snapshot");
      }
      for (const precondition of operation.preconditions) {
        assertBasePrecondition(project, timeline, state, precondition);
      }
      return localOperation(operation, state);
    },
  };
}
