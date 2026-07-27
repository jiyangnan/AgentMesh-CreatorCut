import { describe, expect, it } from "vitest";

import {
  assertCreatorCutOperation,
  OPERATION_CONTRACT_VECTORS,
  validateCreatorCutOperation,
} from "../src/index.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("creatorcut-operations/1.0", () => {
  it("accepts one strict public vector for every advertised operation", () => {
    expect(OPERATION_CONTRACT_VECTORS.valid).toHaveLength(13);
    expect(
      new Set(
        OPERATION_CONTRACT_VECTORS.valid.map(
          (operation) => operation.operation_type,
        ),
      ).size,
    ).toBe(13);
    for (const operation of OPERATION_CONTRACT_VECTORS.valid) {
      expect(assertCreatorCutOperation(operation)).toEqual(operation);
    }
  });

  it("rejects local IDs, extra parameters, invalid ranges and unknown preconditions", () => {
    for (const vector of OPERATION_CONTRACT_VECTORS.invalid) {
      expect(
        validateCreatorCutOperation(vector.operation),
        vector.name,
      ).toMatchObject({ valid: false });
    }
  });

  it("rejects a missing required parameter and an extra parameter for every type", () => {
    const requiredByType: Record<string, string | undefined> = {
      trim: "clip_ref",
      split: "left_clip_ref",
      remove_range: "track_ref",
      concat: "clip_refs",
      set_gain: "gain_millibels",
      add_caption: "text",
      set_canvas: "width",
      apply_lut: "lut_asset_ref",
      move_clip: "track_ref",
      add_clip: "source_asset_ref",
      clear_track: "track_ref",
      clear_captions: undefined,
      clear_lut: undefined,
    };
    for (const valid of OPERATION_CONTRACT_VECTORS.valid) {
      const extra = clone(valid) as Record<string, unknown>;
      (extra.parameters as Record<string, unknown>).unexpected = true;
      expect(
        validateCreatorCutOperation(extra),
        `${valid.operation_type} extra`,
      ).toMatchObject({ valid: false });

      const required = requiredByType[valid.operation_type];
      if (required) {
        const missing = clone(valid) as Record<string, unknown>;
        delete (missing.parameters as Record<string, unknown>)[required];
        expect(
          validateCreatorCutOperation(missing),
          `${valid.operation_type} missing ${required}`,
        ).toMatchObject({ valid: false });
      }
    }
  });

  it("rejects a wrong field type for every advertised operation", () => {
    const wrongTypeFieldByOperation: Record<
      string,
      { field: string; value: unknown } | undefined
    > = {
      trim: { field: "source_start_us", value: "0" },
      split: { field: "at_timeline_us", value: "1000000" },
      remove_range: { field: "ripple_all", value: "true" },
      concat: { field: "clip_refs", value: "clip-main" },
      set_gain: { field: "gain_millibels", value: "-6000" },
      add_caption: { field: "text", value: 7 },
      set_canvas: { field: "width", value: "1080" },
      apply_lut: { field: "intensity_millis", value: "500" },
      move_clip: { field: "track_ref", value: 7 },
      add_clip: { field: "timeline_start_us", value: "2000000" },
      clear_track: { field: "track_ref", value: 7 },
      clear_captions: undefined,
      clear_lut: { field: "clip_ref", value: 7 },
    };
    for (const valid of OPERATION_CONTRACT_VECTORS.valid) {
      const wrongType = clone(valid) as Record<string, unknown>;
      const mutation = wrongTypeFieldByOperation[valid.operation_type];
      if (mutation) {
        (wrongType.parameters as Record<string, unknown>)[mutation.field] =
          mutation.value;
      } else {
        wrongType.base_revision = "4";
      }
      expect(
        validateCreatorCutOperation(wrongType),
        `${valid.operation_type} wrong type`,
      ).toMatchObject({ valid: false });
    }
  });

  it("rejects every operation-specific reversed range", () => {
    const rangeFieldsByOperation: Record<string, [string, string][]> = {
      trim: [["source_start_us", "source_end_us"]],
      remove_range: [
        ["timeline_start_us", "timeline_end_us"],
        ["source_start_us", "source_end_us"],
      ],
      add_caption: [["start_us", "end_us"]],
      add_clip: [
        ["source_start_us", "source_end_us"],
        ["timeline_start_us", "timeline_end_us"],
      ],
    };
    for (const valid of OPERATION_CONTRACT_VECTORS.valid) {
      for (const [startField, endField] of rangeFieldsByOperation[
        valid.operation_type
      ] ?? []) {
        const reversed = clone(valid) as Record<string, unknown>;
        const parameters = reversed.parameters as Record<string, unknown>;
        parameters[startField] = parameters[endField];
        expect(
          validateCreatorCutOperation(reversed),
          `${valid.operation_type} reversed ${startField}/${endField}`,
        ).toMatchObject({ valid: false });
      }
    }
  });
});
