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
});
