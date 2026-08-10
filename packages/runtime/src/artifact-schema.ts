const ARTIFACT_PATHS = [
  "preview-confirmation.json",
  "tasks/import.json",
  "tasks/export.json",
  "tasks/export-locator.json",
  "tasks/transcription.json",
  "tasks/transcription-locator.json",
  "tasks/director-remote-effect.json",
] as const;

export type LocalArtifactPath = (typeof ARTIFACT_PATHS)[number];

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${label}.${key} is required`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${label}.${key} is not allowed`);
    }
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function integer(value: unknown, label: string, maximum?: number): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    (maximum !== undefined && Number(value) > maximum)
  ) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new TypeError(`${label} must be boolean`);
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (!allowed.includes(value as T)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as T;
}

function digest(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^(?:sha256:)?[a-f0-9]{64}$/u.test(result)) {
    throw new TypeError(`${label} must be a SHA-256 digest`);
  }
  return result;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${label} must be a string array`);
  }
  return value;
}

function errorRecord(value: unknown, label: string): void {
  const error = record(value, label);
  exactKeys(error, ["code", "message"], [], label);
  string(error.code, `${label}.code`);
  string(error.message, `${label}.message`);
}

function validatePreview(value: Record<string, unknown>): void {
  const label = "preview confirmation";
  exactKeys(
    value,
    [
      "schema_version",
      "project_id",
      "base_revision",
      "manifest_digest",
      "planned_project_digest",
      "planned_timeline_digest",
      "planned_edit_brief_digest",
      "preview_path",
      "preview_sha256",
      "confirmation_token",
      "created_at",
    ],
    [],
    label,
  );
  if (value.schema_version !== "creatorcut-preview-confirmation/1.0") {
    throw new TypeError(`${label}.schema_version is invalid`);
  }
  string(value.project_id, `${label}.project_id`);
  integer(value.base_revision, `${label}.base_revision`);
  for (const key of [
    "manifest_digest",
    "planned_project_digest",
    "planned_timeline_digest",
    "planned_edit_brief_digest",
    "preview_sha256",
  ]) {
    digest(value[key], `${label}.${key}`);
  }
  string(value.preview_path, `${label}.preview_path`);
  string(value.confirmation_token, `${label}.confirmation_token`);
  string(value.created_at, `${label}.created_at`);
}

function validateImport(value: Record<string, unknown>): void {
  const label = "import task";
  exactKeys(
    value,
    [
      "schema_version",
      "state",
      "source_asset_id",
      "source_sha256",
      "proxy_relative_path",
      "proxy_sha256",
      "completed_at",
    ],
    [],
    label,
  );
  if (value.schema_version !== "creatorcut-import-task/1.0") {
    throw new TypeError(`${label}.schema_version is invalid`);
  }
  oneOf(value.state, ["completed"], `${label}.state`);
  string(value.source_asset_id, `${label}.source_asset_id`);
  digest(value.source_sha256, `${label}.source_sha256`);
  string(value.proxy_relative_path, `${label}.proxy_relative_path`);
  digest(value.proxy_sha256, `${label}.proxy_sha256`);
  string(value.completed_at, `${label}.completed_at`);
}

function validateExportLocator(value: Record<string, unknown>): void {
  const label = "export locator";
  exactKeys(
    value,
    [
      "schema_version",
      "output_path",
      "ffmpeg_path",
      "ffprobe_path",
      "overwrite",
    ],
    [],
    label,
  );
  if (value.schema_version !== "creatorcut-export-locator/1.0") {
    throw new TypeError(`${label}.schema_version is invalid`);
  }
  string(value.output_path, `${label}.output_path`);
  string(value.ffmpeg_path, `${label}.ffmpeg_path`);
  string(value.ffprobe_path, `${label}.ffprobe_path`);
  boolean(value.overwrite, `${label}.overwrite`);
}

function validateExportTask(value: Record<string, unknown>): void {
  const label = "export task";
  exactKeys(
    value,
    [
      "schema_version",
      "task_id",
      "project_id",
      "base_revision",
      "state",
      "progress_millis",
      "created_at",
      "updated_at",
    ],
    ["output_sha256", "output_path", "error", "result"],
    label,
  );
  if (value.schema_version !== "creatorcut-export-task/1.0") {
    throw new TypeError(`${label}.schema_version is invalid`);
  }
  string(value.task_id, `${label}.task_id`);
  string(value.project_id, `${label}.project_id`);
  integer(value.base_revision, `${label}.base_revision`);
  oneOf(
    value.state,
    ["queued", "running", "finalizing", "completed", "failed", "cancelled"],
    `${label}.state`,
  );
  integer(value.progress_millis, `${label}.progress_millis`, 1000);
  string(value.created_at, `${label}.created_at`);
  string(value.updated_at, `${label}.updated_at`);
  if (value.output_sha256 !== undefined)
    digest(value.output_sha256, `${label}.output_sha256`);
  if (value.output_path !== undefined)
    string(value.output_path, `${label}.output_path`);
  if (value.error !== undefined) errorRecord(value.error, `${label}.error`);
  if (value.result !== undefined) {
    const result = record(value.result, `${label}.result`);
    exactKeys(
      result,
      [
        "schema_version",
        "output_path",
        "output_sha256",
        "duration_us",
        "width",
        "height",
        "quality",
      ],
      [],
      `${label}.result`,
    );
    if (result.schema_version !== "creatorcut-render-result/1.0") {
      throw new TypeError(`${label}.result.schema_version is invalid`);
    }
    string(result.output_path, `${label}.result.output_path`);
    digest(result.output_sha256, `${label}.result.output_sha256`);
    integer(result.duration_us, `${label}.result.duration_us`);
    integer(result.width, `${label}.result.width`);
    integer(result.height, `${label}.result.height`);
    oneOf(result.quality, ["preview", "export"], `${label}.result.quality`);
  }
}

function validateTranscriptionLocator(value: Record<string, unknown>): void {
  const label = "transcription locator";
  exactKeys(
    value,
    [
      "schema_version",
      "source_path",
      "model_path",
      "whisper_path",
      "ffmpeg_path",
      "ffprobe_path",
    ],
    [],
    label,
  );
  if (value.schema_version !== "creatorcut-transcription-locator/1.0") {
    throw new TypeError(`${label}.schema_version is invalid`);
  }
  for (const key of [
    "source_path",
    "model_path",
    "whisper_path",
    "ffmpeg_path",
    "ffprobe_path",
  ]) {
    string(value[key], `${label}.${key}`);
  }
}

function validateTranscriptionTask(value: Record<string, unknown>): void {
  const label = "transcription task";
  exactKeys(
    value,
    [
      "schema_version",
      "task_id",
      "project_id",
      "base_revision",
      "source_asset_id",
      "source_sha256",
      "model_sha256",
      "language_mode",
      "glossary",
      "state",
      "progress_millis",
      "completed_steps",
      "created_at",
      "updated_at",
    ],
    ["error", "result"],
    label,
  );
  if (value.schema_version !== "creatorcut-transcription-task/1.0") {
    throw new TypeError(`${label}.schema_version is invalid`);
  }
  string(value.task_id, `${label}.task_id`);
  string(value.project_id, `${label}.project_id`);
  integer(value.base_revision, `${label}.base_revision`);
  string(value.source_asset_id, `${label}.source_asset_id`);
  digest(value.source_sha256, `${label}.source_sha256`);
  digest(value.model_sha256, `${label}.model_sha256`);
  oneOf(
    value.language_mode,
    ["zh", "en", "mixed", "auto"],
    `${label}.language_mode`,
  );
  stringArray(value.glossary, `${label}.glossary`);
  oneOf(
    value.state,
    ["queued", "running", "completed", "failed", "cancelled"],
    `${label}.state`,
  );
  integer(value.progress_millis, `${label}.progress_millis`, 1000);
  stringArray(value.completed_steps, `${label}.completed_steps`);
  string(value.created_at, `${label}.created_at`);
  string(value.updated_at, `${label}.updated_at`);
  if (value.error !== undefined) errorRecord(value.error, `${label}.error`);
  if (value.result !== undefined) {
    const result = record(value.result, `${label}.result`);
    exactKeys(
      result,
      ["transcript_id", "detected_language", "segment_count", "token_count"],
      [],
      `${label}.result`,
    );
    string(result.transcript_id, `${label}.result.transcript_id`);
    oneOf(
      result.detected_language,
      ["zh", "en", "mixed", "other"],
      `${label}.result.detected_language`,
    );
    integer(result.segment_count, `${label}.result.segment_count`);
    integer(result.token_count, `${label}.result.token_count`);
  }
}

function validateDirectorEffect(value: Record<string, unknown>): void {
  const label = "Director remote effect";
  exactKeys(
    value,
    [
      "schema_version",
      "effect_id",
      "effect_kind",
      "project_id",
      "base_revision",
      "planning_input_digest",
      "request_digest",
      "status",
      "created_at",
      "updated_at",
    ],
    ["remote_response_digest", "remote_session_id", "remote_generation_id"],
    label,
  );
  if (value.schema_version !== "creatorcut-director-remote-effect/1.0") {
    throw new TypeError(`${label}.schema_version is invalid`);
  }
  string(value.effect_id, `${label}.effect_id`);
  string(value.effect_kind, `${label}.effect_kind`);
  string(value.project_id, `${label}.project_id`);
  integer(value.base_revision, `${label}.base_revision`);
  digest(value.planning_input_digest, `${label}.planning_input_digest`);
  digest(value.request_digest, `${label}.request_digest`);
  oneOf(
    value.status,
    ["pending", "remote_committed", "completed"],
    `${label}.status`,
  );
  if (value.remote_response_digest !== undefined)
    digest(value.remote_response_digest, `${label}.remote_response_digest`);
  if (value.remote_session_id !== undefined)
    string(value.remote_session_id, `${label}.remote_session_id`);
  if (value.remote_generation_id !== undefined)
    string(value.remote_generation_id, `${label}.remote_generation_id`);
  string(value.created_at, `${label}.created_at`);
  string(value.updated_at, `${label}.updated_at`);
}

export function assertKnownLocalArtifactPath(
  relativePath: string,
): asserts relativePath is LocalArtifactPath {
  if (!(ARTIFACT_PATHS as readonly string[]).includes(relativePath)) {
    throw new TypeError(
      `CreatorCut artifact is outside the public task namespace or has an unknown kind: ${relativePath}`,
    );
  }
}

export function validateLocalArtifact(
  relativePath: string,
  value: unknown,
): unknown {
  assertKnownLocalArtifactPath(relativePath);
  const artifact = record(value, relativePath);
  switch (relativePath) {
    case "preview-confirmation.json":
      validatePreview(artifact);
      break;
    case "tasks/import.json":
      validateImport(artifact);
      break;
    case "tasks/export.json":
      validateExportTask(artifact);
      break;
    case "tasks/export-locator.json":
      validateExportLocator(artifact);
      break;
    case "tasks/transcription.json":
      validateTranscriptionTask(artifact);
      break;
    case "tasks/transcription-locator.json":
      validateTranscriptionLocator(artifact);
      break;
    case "tasks/director-remote-effect.json":
      validateDirectorEffect(artifact);
      break;
  }
  return structuredClone(artifact);
}

export function redactPrivateText(value: string): string {
  return value
    .replaceAll(/(?:\/Users|\/private|\/var|\/tmp)\/[^\s"']+/gu, "[local-path]")
    .replaceAll(/[A-Za-z]:\\[^\s"']+/gu, "[local-path]");
}
