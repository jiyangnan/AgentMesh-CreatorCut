import { createHash } from "node:crypto";

import {
  assertPublicProtocol,
  type EditOperation,
} from "@agentmesh/creatorcut-protocol";
import type {
  LocalMediaProject,
  LocalTimeline,
  LocalTimelineClip,
  LocalTimelineEffect,
  LocalTimelineTrack,
} from "@agentmesh/creatorcut-runtime";

import { createCreatorCutOperationResolver } from "./reference-resolver.js";
import type { ApplyOperationsInput } from "./types.js";

function operationError(operation: EditOperation, message: string): never {
  throw new Error(
    `Cannot apply ${operation.operation_type} (${operation.operation_id}): ${message}`,
  );
}

function hasClip(timeline: LocalTimeline, clipId: string): boolean {
  return timeline.tracks.some((track) =>
    track.clips.some((clip) => clip.clip_id === clipId),
  );
}

function assertPreconditions(
  project: LocalMediaProject,
  timeline: LocalTimeline,
  operation: EditOperation,
): void {
  if (
    project.project_id !== timeline.project_id ||
    project.revision !== timeline.revision ||
    operation.base_revision !== timeline.revision
  ) {
    operationError(
      operation,
      "project, timeline, and operation revision differ",
    );
  }
  for (const precondition of operation.preconditions) {
    switch (precondition.kind) {
      case "revision_equals":
        if (precondition.expected_revision !== timeline.revision) {
          operationError(operation, "revision precondition failed");
        }
        break;
      case "clip_exists":
        if (
          typeof precondition.subject_id !== "string" ||
          !hasClip(timeline, precondition.subject_id)
        ) {
          operationError(operation, "clip precondition failed");
        }
        break;
      case "asset_exists":
        if (
          typeof precondition.subject_id !== "string" ||
          !project.assets.some(
            (asset) => asset.asset_id === precondition.subject_id,
          )
        ) {
          operationError(operation, "asset precondition failed");
        }
        break;
      case "range_within": {
        const track = timeline.tracks.find(
          (candidate) => candidate.track_id === precondition.subject_id,
        );
        if (
          !track ||
          typeof precondition.start_us !== "number" ||
          typeof precondition.end_us !== "number" ||
          precondition.start_us < 0 ||
          precondition.end_us <= precondition.start_us ||
          precondition.end_us > timeline.duration_us
        ) {
          operationError(operation, "range precondition failed");
        }
        break;
      }
    }
  }
}

function stringParameter(operation: EditOperation, name: string): string {
  const value = operation.parameters[name];
  if (typeof value !== "string" || !value) {
    operationError(operation, `${name} must be a non-empty string`);
  }
  return value;
}

function integerParameter(operation: EditOperation, name: string): number {
  const value = operation.parameters[name];
  if (!Number.isSafeInteger(value)) {
    operationError(operation, `${name} must be a safe integer`);
  }
  return value as number;
}

function stringArrayParameter(
  operation: EditOperation,
  name: string,
): string[] {
  const value = operation.parameters[name];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string")
  ) {
    operationError(operation, `${name} must be a non-empty array of IDs`);
  }
  return value as string[];
}

function findTrack(
  timeline: LocalTimeline,
  trackId: string,
  operation: EditOperation,
): LocalTimelineTrack {
  const track = timeline.tracks.find(
    (candidate) => candidate.track_id === trackId,
  );
  if (!track) operationError(operation, `unknown track_id: ${trackId}`);
  return track;
}

function findClip(
  timeline: LocalTimeline,
  clipId: string,
  operation: EditOperation,
): { track: LocalTimelineTrack; clip: LocalTimelineClip; index: number } {
  for (const track of timeline.tracks) {
    const index = track.clips.findIndex(
      (candidate) => candidate.clip_id === clipId,
    );
    if (index >= 0) {
      const clip = track.clips[index];
      if (clip) return { track, clip, index };
    }
  }
  operationError(operation, `unknown clip_id: ${clipId}`);
}

function sourceAtTimeline(
  clip: LocalTimelineClip,
  timelinePosition: number,
): number {
  const timelineDuration = clip.timeline_end_us - clip.timeline_start_us;
  const sourceDuration = clip.source_end_us - clip.source_start_us;
  return (
    clip.source_start_us +
    Math.round(
      ((timelinePosition - clip.timeline_start_us) * sourceDuration) /
        timelineDuration,
    )
  );
}

function clipTimelineDuration(
  clip: LocalTimelineClip,
  sourceDuration: number,
): number {
  return Math.round(
    (sourceDuration * (clip.speed_denominator ?? 1)) /
      (clip.speed_numerator ?? 1),
  );
}

function derivedId(
  base: string,
  side: "left" | "right",
  operationId: string,
): string {
  const digest = createHash("sha256")
    .update(operationId)
    .digest("hex")
    .slice(0, 12);
  return `${base.slice(0, 96)}:${side}:${digest}`;
}

function removeMissingEffects(timeline: LocalTimeline): void {
  if (!timeline.effects) return;
  const clips = new Set(
    timeline.tracks.flatMap((track) => track.clips.map((clip) => clip.clip_id)),
  );
  timeline.effects = timeline.effects.filter((effect) =>
    clips.has(effect.target_clip_id),
  );
}

function applyTrim(
  project: LocalMediaProject,
  timeline: LocalTimeline,
  operation: EditOperation,
): void {
  const { clip } = findClip(
    timeline,
    stringParameter(operation, "clip_id"),
    operation,
  );
  const start = integerParameter(operation, "source_start_us");
  const end = integerParameter(operation, "source_end_us");
  const asset = project.assets.find(
    (candidate) => candidate.asset_id === clip.asset_id,
  );
  if (!asset || start < 0 || end <= start || end > asset.duration_us) {
    operationError(operation, "trim range is outside the source asset");
  }
  clip.source_start_us = start;
  clip.source_end_us = end;
  clip.timeline_end_us =
    clip.timeline_start_us + clipTimelineDuration(clip, end - start);
}

function applySplit(timeline: LocalTimeline, operation: EditOperation): void {
  const clipId = stringParameter(operation, "clip_id");
  const at = integerParameter(operation, "at_timeline_us");
  const leftClipId = stringParameter(operation, "left_clip_id");
  const rightClipId = stringParameter(operation, "right_clip_id");
  if (hasClip(timeline, leftClipId) || hasClip(timeline, rightClipId)) {
    operationError(operation, "split output clip ID already exists");
  }
  const { track, clip, index } = findClip(timeline, clipId, operation);
  if (at <= clip.timeline_start_us || at >= clip.timeline_end_us) {
    operationError(operation, "split point must be inside the clip");
  }
  const sourceAt = sourceAtTimeline(clip, at);
  track.clips.splice(
    index,
    1,
    {
      ...clip,
      clip_id: leftClipId,
      source_end_us: sourceAt,
      timeline_end_us: at,
    },
    {
      ...clip,
      clip_id: rightClipId,
      source_start_us: sourceAt,
      timeline_start_us: at,
    },
  );
  if (timeline.effects) {
    timeline.effects = timeline.effects.flatMap((effect) =>
      effect.target_clip_id === clipId
        ? [
            {
              ...effect,
              effect_id: `${effect.effect_id}:left`,
              target_clip_id: leftClipId,
            },
            {
              ...effect,
              effect_id: `${effect.effect_id}:right`,
              target_clip_id: rightClipId,
            },
          ]
        : [effect],
    );
  }
}

function removeRangeFromClip(
  clip: LocalTimelineClip,
  start: number,
  end: number,
  operation: EditOperation,
): LocalTimelineClip[] {
  const removed = end - start;
  if (clip.timeline_end_us <= start) return [clip];
  if (clip.timeline_start_us >= end) {
    return [
      {
        ...clip,
        timeline_start_us: clip.timeline_start_us - removed,
        timeline_end_us: clip.timeline_end_us - removed,
      },
    ];
  }
  if (clip.timeline_start_us >= start && clip.timeline_end_us <= end) return [];
  if (clip.timeline_start_us < start && clip.timeline_end_us > end) {
    return [
      {
        ...clip,
        clip_id: derivedId(clip.clip_id, "left", operation.operation_id),
        source_end_us: sourceAtTimeline(clip, start),
        timeline_end_us: start,
      },
      {
        ...clip,
        clip_id: derivedId(clip.clip_id, "right", operation.operation_id),
        source_start_us: sourceAtTimeline(clip, end),
        timeline_start_us: start,
        timeline_end_us: clip.timeline_end_us - removed,
      },
    ];
  }
  if (clip.timeline_start_us < start) {
    return [
      {
        ...clip,
        source_end_us: sourceAtTimeline(clip, start),
        timeline_end_us: start,
      },
    ];
  }
  return [
    {
      ...clip,
      source_start_us: sourceAtTimeline(clip, end),
      timeline_start_us: start,
      timeline_end_us: clip.timeline_end_us - removed,
    },
  ];
}

function applyRemoveRange(
  timeline: LocalTimeline,
  operation: EditOperation,
): void {
  const selected = findTrack(
    timeline,
    stringParameter(operation, "track_id"),
    operation,
  );
  const start = integerParameter(operation, "timeline_start_us");
  const end = integerParameter(operation, "timeline_end_us");
  if (start < 0 || end <= start || end > timeline.duration_us) {
    operationError(operation, "remove range is invalid");
  }
  const tracks =
    operation.parameters.ripple_all === true ? timeline.tracks : [selected];
  for (const track of tracks) {
    track.clips = track.clips.flatMap((clip) =>
      removeRangeFromClip(clip, start, end, operation),
    );
  }
  if (operation.parameters.ripple_all === true && timeline.captions) {
    const removed = end - start;
    timeline.captions = timeline.captions.flatMap((caption) => {
      if (caption.end_us <= start) return [caption];
      if (caption.start_us >= end) {
        return [
          {
            ...caption,
            start_us: caption.start_us - removed,
            end_us: caption.end_us - removed,
          },
        ];
      }
      if (caption.start_us >= start && caption.end_us <= end) return [];
      if (caption.start_us < start && caption.end_us > end) {
        return [{ ...caption, end_us: caption.end_us - removed }];
      }
      return caption.start_us < start
        ? [{ ...caption, end_us: start }]
        : [{ ...caption, start_us: start, end_us: caption.end_us - removed }];
    });
  }
  removeMissingEffects(timeline);
}

function applyConcat(timeline: LocalTimeline, operation: EditOperation): void {
  const track = findTrack(
    timeline,
    stringParameter(operation, "track_id"),
    operation,
  );
  const ids = stringArrayParameter(operation, "clip_ids");
  const byId = new Map(track.clips.map((clip) => [clip.clip_id, clip]));
  const selected = ids.map((id) => {
    const clip = byId.get(id);
    if (!clip) operationError(operation, `unknown concat clip: ${id}`);
    return clip;
  });
  let cursor = Math.min(...selected.map((clip) => clip.timeline_start_us));
  for (const clip of selected) {
    const duration = clip.timeline_end_us - clip.timeline_start_us;
    clip.timeline_start_us = cursor;
    clip.timeline_end_us = cursor + duration;
    cursor += duration;
  }
  track.clips.sort(
    (left, right) => left.timeline_start_us - right.timeline_start_us,
  );
}

function applyGain(timeline: LocalTimeline, operation: EditOperation): void {
  const track = findTrack(
    timeline,
    stringParameter(operation, "track_id"),
    operation,
  );
  const gain = integerParameter(operation, "gain_millibels");
  if (gain < -60_000 || gain > 12_000) {
    operationError(operation, "gain is outside the safe range");
  }
  for (const clip of track.clips) clip.gain_millibels = gain;
}

function applyCaption(timeline: LocalTimeline, operation: EditOperation): void {
  const start = integerParameter(operation, "start_us");
  const end = integerParameter(operation, "end_us");
  if (start < 0 || end <= start || end > timeline.duration_us) {
    operationError(operation, "caption range is invalid");
  }
  const style = operation.parameters.style_id;
  timeline.captions ??= [];
  timeline.captions.push({
    caption_id: stringParameter(operation, "caption_id"),
    start_us: start,
    end_us: end,
    text: stringParameter(operation, "text"),
    ...(typeof style === "string" ? { style_id: style } : {}),
  });
}

function applyCanvas(timeline: LocalTimeline, operation: EditOperation): void {
  const width = integerParameter(operation, "width");
  const height = integerParameter(operation, "height");
  if (
    width < 16 ||
    height < 16 ||
    width > 7680 ||
    height > 7680 ||
    width % 2 !== 0 ||
    height % 2 !== 0
  ) {
    operationError(operation, "canvas size is outside the safe range");
  }
  timeline.canvas = {
    width,
    height,
    framing: timeline.canvas.framing ?? {
      mode: "fit_blur",
      focus_x_millis: 500,
      focus_y_millis: 500,
    },
  };
}

function applyLut(
  project: LocalMediaProject,
  timeline: LocalTimeline,
  operation: EditOperation,
): void {
  const clipId = stringParameter(operation, "clip_id");
  findClip(timeline, clipId, operation);
  const lutAssetId = stringParameter(operation, "lut_asset_id");
  if (
    !project.assets.some(
      (asset) => asset.asset_id === lutAssetId && asset.kind === "lut",
    )
  ) {
    operationError(operation, "LUT asset is missing");
  }
  const intensity = integerParameter(operation, "intensity_millis");
  if (intensity < 0 || intensity > 1000) {
    operationError(operation, "LUT intensity is outside 0..1000");
  }
  const effect: LocalTimelineEffect = {
    effect_id: `effect:${operation.operation_id}`,
    type: "lut",
    target_clip_id: clipId,
    lut_asset_id: lutAssetId,
    intensity_millis: intensity,
  };
  timeline.effects = [
    ...(timeline.effects ?? []).filter(
      (candidate) =>
        !(candidate.type === "lut" && candidate.target_clip_id === clipId),
    ),
    effect,
  ];
}

function applyAddClip(
  project: LocalMediaProject,
  timeline: LocalTimeline,
  operation: EditOperation,
): void {
  const track = findTrack(
    timeline,
    stringParameter(operation, "track_id"),
    operation,
  );
  const clipId = stringParameter(operation, "clip_id");
  if (hasClip(timeline, clipId)) operationError(operation, "clip ID exists");
  const assetId = stringParameter(operation, "asset_id");
  const asset = project.assets.find(
    (candidate) => candidate.asset_id === assetId,
  );
  if (!asset) operationError(operation, "asset is missing");
  const sourceStart = integerParameter(operation, "source_start_us");
  const sourceEnd = integerParameter(operation, "source_end_us");
  const timelineStart = integerParameter(operation, "timeline_start_us");
  const timelineEnd = integerParameter(operation, "timeline_end_us");
  if (
    sourceStart < 0 ||
    sourceEnd <= sourceStart ||
    sourceEnd > asset.duration_us ||
    timelineStart < 0 ||
    timelineEnd <= timelineStart
  ) {
    operationError(operation, "clip ranges are invalid");
  }
  const gain = operation.parameters.gain_millibels;
  track.clips.push({
    clip_id: clipId,
    asset_id: assetId,
    source_start_us: sourceStart,
    source_end_us: sourceEnd,
    timeline_start_us: timelineStart,
    timeline_end_us: timelineEnd,
    ...(typeof gain === "number" ? { gain_millibels: gain } : {}),
  });
  track.clips.sort(
    (left, right) => left.timeline_start_us - right.timeline_start_us,
  );
}

function reflow(track: LocalTimelineTrack): void {
  let cursor = 0;
  for (const clip of track.clips) {
    const duration = clip.timeline_end_us - clip.timeline_start_us;
    clip.timeline_start_us = cursor;
    clip.timeline_end_us = cursor + duration;
    cursor += duration;
  }
}

function applyMoveClip(
  timeline: LocalTimeline,
  operation: EditOperation,
): void {
  const clipId = stringParameter(operation, "clip_id");
  const target = findTrack(
    timeline,
    stringParameter(operation, "track_id"),
    operation,
  );
  const source = findClip(timeline, clipId, operation);
  if (source.track.kind !== target.kind) {
    operationError(operation, "move_clip cannot change track kind");
  }
  source.track.clips.splice(source.index, 1);
  const before = operation.parameters.before_clip_id;
  const index =
    typeof before === "string"
      ? target.clips.findIndex((clip) => clip.clip_id === before)
      : target.clips.length;
  if (typeof before === "string" && index < 0) {
    operationError(operation, "before clip is missing");
  }
  target.clips.splice(index, 0, source.clip);
  reflow(source.track);
  if (target !== source.track) reflow(target);
}

function recomputeDuration(timeline: LocalTimeline): void {
  timeline.duration_us = Math.max(
    0,
    ...timeline.tracks.flatMap((track) =>
      track.clips.map((clip) => clip.timeline_end_us),
    ),
    ...(timeline.captions ?? []).map((caption) => caption.end_us),
  );
}

export function applyEditOperations(
  input: ApplyOperationsInput,
): LocalTimeline {
  const timeline = structuredClone(input.timeline);
  const resolver = createCreatorCutOperationResolver(
    input.project,
    input.timeline,
  );
  const seen = new Set<string>();
  for (const raw of input.operations) {
    assertPublicProtocol<EditOperation>("edit-operation", raw);
    const operation = resolver.resolve(raw);
    if (seen.has(operation.operation_id)) {
      operationError(operation, "duplicate operation ID");
    }
    seen.add(operation.operation_id);
    assertPreconditions(input.project, timeline, operation);
    switch (operation.operation_type) {
      case "trim":
        applyTrim(input.project, timeline, operation);
        break;
      case "split":
        applySplit(timeline, operation);
        break;
      case "remove_range":
        applyRemoveRange(timeline, operation);
        break;
      case "concat":
        applyConcat(timeline, operation);
        break;
      case "set_gain":
        applyGain(timeline, operation);
        break;
      case "add_caption":
        applyCaption(timeline, operation);
        break;
      case "set_canvas":
        applyCanvas(timeline, operation);
        break;
      case "apply_lut":
        applyLut(input.project, timeline, operation);
        break;
      case "move_clip":
        applyMoveClip(timeline, operation);
        break;
      case "add_clip":
        applyAddClip(input.project, timeline, operation);
        break;
      case "clear_track": {
        const track = findTrack(
          timeline,
          stringParameter(operation, "track_id"),
          operation,
        );
        track.clips = [];
        removeMissingEffects(timeline);
        break;
      }
      case "clear_captions":
        timeline.captions = [];
        break;
      case "clear_lut": {
        const clipId = operation.parameters.clip_id;
        timeline.effects = (timeline.effects ?? []).filter(
          (effect) =>
            effect.type !== "lut" ||
            (typeof clipId === "string" && effect.target_clip_id !== clipId),
        );
        break;
      }
    }
    recomputeDuration(timeline);
  }
  return timeline;
}
