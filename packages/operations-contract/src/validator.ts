import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

import operationContractSchema from "../schemas/edit-operation-contract.schema.json" with { type: "json" };
import type {
  CreatorCutOperationPrecondition,
  CreatorCutWireOperation,
  OperationsContractIssue,
  OperationsContractValidation,
} from "./types.js";

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
});
const validateSchema = ajv.compile(operationContractSchema);

function ajvIssues(
  errors: ErrorObject[] | null | undefined,
): OperationsContractIssue[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath || "/",
    code: `schema.${error.keyword}`,
    message: error.message ?? error.keyword,
  }));
}

function rangeIssue(
  start: unknown,
  end: unknown,
  path: string,
): OperationsContractIssue[] {
  return typeof start === "number" &&
    typeof end === "number" &&
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    end <= start
    ? [
        {
          path,
          code: "semantic.invalid_range",
          message: "range end must be greater than range start",
        },
      ]
    : [];
}

function preconditionIssues(
  preconditions: CreatorCutOperationPrecondition[],
): OperationsContractIssue[] {
  return preconditions.flatMap((precondition, index) => {
    if (precondition.kind === "range_within") {
      return rangeIssue(
        precondition.start_us,
        precondition.end_us,
        `/preconditions/${index}`,
      );
    }
    if (precondition.kind === "clip_mapping_equals") {
      return rangeIssue(
        precondition.source_start_us,
        precondition.source_end_us,
        `/preconditions/${index}`,
      );
    }
    return [];
  });
}

function operationIssues(
  operation: CreatorCutWireOperation,
): OperationsContractIssue[] {
  switch (operation.operation_type) {
    case "trim":
      return rangeIssue(
        operation.parameters.source_start_us,
        operation.parameters.source_end_us,
        "/parameters",
      );
    case "remove_range": {
      const issues = rangeIssue(
        operation.parameters.timeline_start_us,
        operation.parameters.timeline_end_us,
        "/parameters",
      );
      const hasSourceStart = operation.parameters.source_start_us !== undefined;
      const hasSourceEnd = operation.parameters.source_end_us !== undefined;
      if (hasSourceStart !== hasSourceEnd) {
        issues.push({
          path: "/parameters",
          code: "semantic.incomplete_source_range",
          message:
            "source_start_us and source_end_us must either both be present or both be absent",
        });
      } else if (hasSourceStart && hasSourceEnd) {
        issues.push(
          ...rangeIssue(
            operation.parameters.source_start_us,
            operation.parameters.source_end_us,
            "/parameters",
          ),
        );
      }
      return issues;
    }
    case "add_caption":
      return rangeIssue(
        operation.parameters.start_us,
        operation.parameters.end_us,
        "/parameters",
      );
    case "add_clip":
      return [
        ...rangeIssue(
          operation.parameters.source_start_us,
          operation.parameters.source_end_us,
          "/parameters",
        ),
        ...rangeIssue(
          operation.parameters.timeline_start_us,
          operation.parameters.timeline_end_us,
          "/parameters",
        ),
      ];
    default:
      return [];
  }
}

export function validateCreatorCutOperation(
  input: unknown,
): OperationsContractValidation {
  if (!validateSchema(input)) {
    return {
      valid: false,
      issues: ajvIssues(validateSchema.errors),
    };
  }
  const value = input as unknown as CreatorCutWireOperation;
  const issues = [
    ...preconditionIssues(value.preconditions),
    ...operationIssues(value),
  ];
  return issues.length > 0
    ? { valid: false, issues }
    : { valid: true, value, issues: [] };
}

export function assertCreatorCutOperation<T extends CreatorCutWireOperation>(
  input: T,
): T;
export function assertCreatorCutOperation(
  input: unknown,
): CreatorCutWireOperation;
export function assertCreatorCutOperation(
  input: unknown,
): CreatorCutWireOperation {
  const result = validateCreatorCutOperation(input);
  if (!result.valid || !result.value) {
    const detail = result.issues
      .map((issue) => `${issue.path} ${issue.code}: ${issue.message}`)
      .join("; ");
    throw new TypeError(
      `Invalid creatorcut-operations/1.0 operation: ${detail}`,
    );
  }
  return result.value;
}
