import { digestJcs, type EditOperation } from "@agentmesh/creatorcut-protocol";
import { OPERATION_CONTRACT_VECTORS } from "@agentmesh/creatorcut-operations-contract";
import type {
  LocalMediaProject,
  LocalTimeline,
} from "@agentmesh/creatorcut-runtime";
import { describe, expect, it } from "vitest";

import { applyEditOperations } from "../src/index.js";

function matrixFixture(operationType?: string): {
  project: LocalMediaProject;
  timeline: LocalTimeline;
} {
  return {
    project: {
      schema_version: "1.0",
      project_id: "project-operation-matrix",
      name: "Operation matrix",
      revision: 4,
      assets: [
        {
          asset_id: "asset-main",
          kind: "video",
          relative_path: "media/main.mp4",
          sha256: "a".repeat(64),
          duration_us: 10_000_000,
          has_video: true,
          has_audio: true,
        },
        {
          asset_id: "lut-clean",
          kind: "lut",
          relative_path: "media/clean.cube",
          sha256: "b".repeat(64),
          duration_us: 0,
        },
      ],
    },
    timeline: {
      schema_version: "1.0",
      timeline_id: "timeline-operation-matrix",
      project_id: "project-operation-matrix",
      revision: 4,
      duration_us: 5_000_000,
      canvas: { width: 1920, height: 1080 },
      tracks: [
        {
          track_id: "track-main",
          kind: "video",
          clips: [
            {
              clip_id: "clip-main",
              asset_id: "asset-main",
              source_start_us: 0,
              source_end_us: 2_000_000,
              timeline_start_us: 0,
              timeline_end_us: 2_000_000,
            },
            ...(operationType === "split"
              ? []
              : [
                  {
                    clip_id: "clip-left",
                    asset_id: "asset-main",
                    source_start_us: 2_000_000,
                    source_end_us: 2_500_000,
                    timeline_start_us: 2_500_000,
                    timeline_end_us: 3_000_000,
                  },
                  {
                    clip_id: "clip-right",
                    asset_id: "asset-main",
                    source_start_us: 3_000_000,
                    source_end_us: 4_000_000,
                    timeline_start_us: 3_500_000,
                    timeline_end_us: 4_500_000,
                  },
                ]),
          ],
        },
        {
          track_id: "track-b",
          kind: "video",
          clips: [
            {
              clip_id: "clip-b",
              asset_id: "asset-main",
              source_start_us: 4_000_000,
              source_end_us: 5_000_000,
              timeline_start_us: 0,
              timeline_end_us: 1_000_000,
            },
          ],
        },
      ],
      captions: [
        {
          caption_id: "caption-existing",
          start_us: 4_800_000,
          end_us: 4_900_000,
          text: "Existing",
        },
      ],
      effects: [
        {
          effect_id: "effect-existing",
          type: "lut",
          target_clip_id: "clip-main",
          lut_asset_id: "lut-clean",
          intensity_millis: 250,
        },
      ],
    },
  };
}

function assertGoldenResult(
  operationType: string,
  timeline: LocalTimeline,
): void {
  const main = timeline.tracks.find((track) => track.track_id === "track-main");
  const trackB = timeline.tracks.find((track) => track.track_id === "track-b");
  const mainClip = timeline.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.clip_id === "clip-main");

  switch (operationType) {
    case "trim":
      expect(mainClip).toMatchObject({
        source_start_us: 100_000,
        source_end_us: 900_000,
        timeline_end_us: 800_000,
      });
      return;
    case "split":
      expect(mainClip).toBeUndefined();
      expect(
        main?.clips.filter((clip) => clip.clip_id.startsWith("clip:wire:")),
      ).toHaveLength(2);
      return;
    case "remove_range":
      expect(timeline.duration_us).toBeLessThan(5_000_000);
      expect(main?.clips.map((clip) => clip.clip_id)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^clip-main:left:/u),
          expect.stringMatching(/^clip-main:right:/u),
        ]),
      );
      return;
    case "concat":
      expect(
        main?.clips.find((clip) => clip.clip_id === "clip-left"),
      ).toMatchObject({
        timeline_start_us: 2_500_000,
        timeline_end_us: 3_000_000,
      });
      expect(
        main?.clips.find((clip) => clip.clip_id === "clip-right"),
      ).toMatchObject({
        timeline_start_us: 3_000_000,
        timeline_end_us: 4_000_000,
      });
      return;
    case "set_gain":
      expect(main?.clips.every((clip) => clip.gain_millibels === -6_000)).toBe(
        true,
      );
      return;
    case "add_caption":
      expect(timeline.captions).toContainEqual(
        expect.objectContaining({
          caption_id: expect.stringMatching(/^caption:wire:/u),
          text: "CreatorCut",
        }),
      );
      return;
    case "set_canvas":
      expect(timeline.canvas).toMatchObject({ width: 1080, height: 1920 });
      return;
    case "apply_lut":
      expect(timeline.effects).toContainEqual(
        expect.objectContaining({
          target_clip_id: "clip-main",
          lut_asset_id: "lut-clean",
          intensity_millis: 500,
        }),
      );
      return;
    case "move_clip":
      expect(mainClip).toBeDefined();
      expect(main?.clips.some((clip) => clip.clip_id === "clip-main")).toBe(
        false,
      );
      expect(trackB?.clips[0]?.clip_id).toBe("clip-main");
      return;
    case "add_clip":
      expect(main?.clips).toContainEqual(
        expect.objectContaining({
          clip_id: expect.stringMatching(/^clip:wire:/u),
          asset_id: "asset-main",
          timeline_start_us: 2_000_000,
          timeline_end_us: 3_000_000,
        }),
      );
      return;
    case "clear_track":
      expect(main?.clips).toEqual([]);
      return;
    case "clear_captions":
      expect(timeline.captions).toEqual([]);
      return;
    case "clear_lut":
      expect(timeline.effects).toEqual([]);
      return;
    default:
      throw new Error(`Missing operation golden assertion: ${operationType}`);
  }
}

describe.each(OPERATION_CONTRACT_VECTORS.valid)(
  "$operation_type operation",
  (operation) => {
    it("has a deterministic apply golden case", () => {
      const typedOperation = operation as unknown as EditOperation;
      const fixture = matrixFixture(operation.operation_type);
      const first = applyEditOperations({
        ...fixture,
        operations: [typedOperation],
      });
      const second = applyEditOperations({
        ...matrixFixture(operation.operation_type),
        operations: [typedOperation],
      });

      expect(digestJcs(first)).toBe(digestJcs(second));
      assertGoldenResult(operation.operation_type, first);
    });
  },
);
