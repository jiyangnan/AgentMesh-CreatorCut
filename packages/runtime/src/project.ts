import {
  access,
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  assertPublicProtocol,
  digestJcs,
  type DirectorContext,
} from "@agentmesh/creatorcut-protocol";
import { buildPublicClientCapabilities } from "@agentmesh/creatorcut-client-capabilities";

import {
  localAssetWireRef,
  localClipWireRef,
  localTrackWireRef,
} from "./references.js";
import type {
  BuildDirectorContextOptions,
  CommitLocalRevisionInput,
  CreateLocalProjectInput,
  DirectorConsentRecord,
  DirectorContextInspection,
  LocalEditBrief,
  LocalMediaProject,
  LocalOperationLogEntry,
  LocalProjectSnapshot,
  LocalRevisionHistory,
  LocalTimeline,
  LocalTranscript,
  OpenedCreatorCutProject,
} from "./types.js";

const PUBLIC_PROTOCOL_VERSION = "1.0";
const DEFAULT_CONSENT_VERSION = "director-context-consent-v1";
const CONSENT_FILE = "director-consent.json";
const REMOTE_STATE_FILE = "director-state.json";
const HISTORY_FILE = "history.json";
const OPERATIONS_FILE = "operations.jsonl";
const LOCK_FILE = "project.lock";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function assertProject(value: unknown): LocalMediaProject {
  const project = requireRecord(value, "project");
  requireString(project.project_id, "project.project_id");
  requireString(project.name, "project.name");
  requireInteger(project.revision, "project.revision");
  if (!Array.isArray(project.assets) || project.assets.length === 0) {
    throw new TypeError("project.assets must contain at least one local asset");
  }
  for (const [index, valueAsset] of project.assets.entries()) {
    const asset = requireRecord(valueAsset, `project.assets[${index}]`);
    requireString(asset.asset_id, `project.assets[${index}].asset_id`);
    requireString(
      asset.relative_path,
      `project.assets[${index}].relative_path`,
    );
    requireString(asset.sha256, `project.assets[${index}].sha256`);
    requireInteger(asset.duration_us, `project.assets[${index}].duration_us`);
  }
  return project as unknown as LocalMediaProject;
}

function assertTimeline(value: unknown): LocalTimeline {
  const timeline = requireRecord(value, "timeline");
  requireString(timeline.timeline_id, "timeline.timeline_id");
  requireString(timeline.project_id, "timeline.project_id");
  requireInteger(timeline.revision, "timeline.revision");
  requireInteger(timeline.duration_us, "timeline.duration_us");
  requireRecord(timeline.canvas, "timeline.canvas");
  if (!Array.isArray(timeline.tracks)) {
    throw new TypeError("timeline.tracks must be an array");
  }
  return timeline as unknown as LocalTimeline;
}

function assertTranscript(value: unknown): LocalTranscript {
  const transcript = requireRecord(value, "transcript");
  requireString(transcript.transcript_id, "transcript.transcript_id");
  requireString(transcript.project_id, "transcript.project_id");
  requireInteger(transcript.revision, "transcript.revision");
  if (!Array.isArray(transcript.segments)) {
    throw new TypeError("transcript.segments must be an array");
  }
  return transcript as unknown as LocalTranscript;
}

function assertEditBrief(value: unknown): LocalEditBrief {
  const editBrief = requireRecord(value, "edit brief");
  requireString(editBrief.brief_id, "edit_brief.brief_id");
  requireString(editBrief.project_id, "edit_brief.project_id");
  requireInteger(editBrief.base_revision, "edit_brief.base_revision");
  if (editBrief.approved !== true) {
    throw new TypeError("Cloud Director requires an approved edit brief");
  }
  return editBrief as unknown as LocalEditBrief;
}

function assertSameRevision(project: OpenedCreatorCutProject): void {
  const expectedId = project.project.project_id;
  const expectedRevision = project.project.revision;
  for (const [label, id, revision] of [
    ["timeline", project.timeline.project_id, project.timeline.revision],
    ["transcript", project.transcript.project_id, project.transcript.revision],
    [
      "edit brief",
      project.editBrief.project_id,
      project.editBrief.base_revision,
    ],
  ] as const) {
    if (id !== expectedId || revision !== expectedRevision) {
      throw new TypeError(
        `${label} is stale or belongs to a different CreatorCut project`,
      );
    }
  }
}

export async function openCreatorCutProject(
  projectDirectory: string,
): Promise<OpenedCreatorCutProject> {
  const directory = await realpath(resolve(projectDirectory));
  const creatorcutDirectory = join(directory, ".creatorcut");
  const project: OpenedCreatorCutProject = {
    directory,
    creatorcutDirectory,
    project: assertProject(
      await readJson(join(creatorcutDirectory, "project.json")),
    ),
    timeline: assertTimeline(
      await readJson(join(creatorcutDirectory, "timeline.json")),
    ),
    transcript: assertTranscript(
      await readJson(join(creatorcutDirectory, "transcript.json")),
    ),
    editBrief: assertEditBrief(
      await readJson(join(creatorcutDirectory, "edit-brief.json")),
    ),
  };
  assertSameRevision(project);
  return project;
}

export function buildDirectorContext(
  opened: OpenedCreatorCutProject,
  options: BuildDirectorContextOptions = {},
): DirectorContext {
  const source =
    opened.project.assets.find((asset) => asset.kind === "video") ??
    opened.project.assets.find((asset) => asset.kind === "audio");
  if (!source) throw new TypeError("Project has no video or audio source");
  const capabilities = buildPublicClientCapabilities(
    options.hostType ?? "text",
    options.clientVersion ?? "0.1.0",
  );
  const timeline: DirectorContext["timeline"] = {
    duration_us: opened.timeline.duration_us,
    canvas: {
      width: opened.timeline.canvas.width,
      height: opened.timeline.canvas.height,
    },
    tracks: opened.timeline.tracks.map((track) => ({
      track_ref: localTrackWireRef(track),
      kind: track.kind,
      clips: track.clips.map((clip) => ({
        clip_ref: localClipWireRef(clip),
        source_asset_ref: localAssetWireRef(clip.asset_id),
        source_start_us: clip.source_start_us,
        source_end_us: clip.source_end_us,
        timeline_start_us: clip.timeline_start_us,
        timeline_end_us: clip.timeline_end_us,
      })),
    })),
  };
  const segments: DirectorContext["transcript"]["segments"] =
    opened.transcript.segments.map((segment) => ({
      segment_id: segment.segment_id,
      source_asset_ref: segment.source_asset_id,
      start_us: segment.start_us,
      end_us: segment.end_us,
      text: segment.display_text,
      tokens: segment.tokens.map((token) => ({
        token_id: token.token_id,
        start_us: token.start_us,
        end_us: token.end_us,
        text: token.text,
        language: token.language,
        confidence_millis: Math.max(
          0,
          Math.min(1000, Math.round(token.confidence * 1000)),
        ),
      })),
    }));
  const transcript: DirectorContext["transcript"] = {
    language_mode: opened.transcript.language_mode,
    text_utf8_bytes: Buffer.byteLength(
      segments.map((segment) => segment.text).join(""),
      "utf8",
    ),
    segment_count: segments.length,
    token_count: segments.reduce(
      (count, segment) => count + segment.tokens.length,
      0,
    ),
    silence_intervals: (opened.transcript.silence_intervals ?? []).map(
      (interval) => ({
        silence_id: interval.silence_id,
        source_asset_ref: interval.source_asset_id,
        start_us: interval.start_us,
        end_us: interval.end_us,
        detector: "local_audio",
      }),
    ),
    segments,
  };
  return assertPublicProtocol<DirectorContext>("director-context", {
    schema_version: PUBLIC_PROTOCOL_VERSION,
    project_id: opened.project.project_id,
    base_revision: opened.project.revision,
    client_version: capabilities.client_version,
    protocol_versions: [PUBLIC_PROTOCOL_VERSION],
    consent_version: options.consentVersion ?? DEFAULT_CONSENT_VERSION,
    project_digest: digestJcs({
      project_id: opened.project.project_id,
      revision: opened.project.revision,
      assets: opened.project.assets.map((asset) => ({
        asset_ref: asset.asset_id,
        kind: asset.kind,
        sha256: asset.sha256,
        duration_us: asset.duration_us,
      })),
    }),
    timeline_digest: digestJcs(timeline),
    transcript_digest: digestJcs(transcript),
    edit_brief_digest: digestJcs(opened.editBrief),
    capabilities_digest: digestJcs(capabilities),
    media: {
      source_asset_ref: source.asset_id,
      duration_us: source.duration_us,
      width: source.width ?? opened.timeline.canvas.width,
      height: source.height ?? opened.timeline.canvas.height,
      has_video: source.has_video ?? source.kind === "video",
      has_audio: source.has_audio ?? source.kind === "audio",
    },
    timeline,
    transcript,
    capabilities,
    local_facts: {
      project_kind: options.projectKind ?? "mixed",
      voice_generation_available: options.voiceGenerationAvailable ?? false,
      ...(options.currentFinishing
        ? { current_finishing: options.currentFinishing }
        : {}),
    },
  });
}

export function inspectDirectorContext(
  context: DirectorContext,
): DirectorContextInspection {
  const planningInputDigest = digestJcs(context);
  const uploadBytes = Buffer.byteLength(JSON.stringify(context), "utf8");
  return {
    schema_version: "creatorcut-context-inspection/1.0",
    project_id: context.project_id,
    base_revision: context.base_revision,
    planning_input_digest: planningInputDigest,
    upload_bytes: uploadBytes,
    uploads_original_media: false,
    uploads_screenshots: false,
    uploads_absolute_paths: false,
    transcript: {
      language_mode: context.transcript.language_mode,
      segment_count: context.transcript.segment_count,
      token_count: context.transcript.token_count,
      text_utf8_bytes: context.transcript.text_utf8_bytes,
    },
    fields: Object.keys(context).sort(),
    context: structuredClone(context),
  };
}

async function atomicPrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function withProjectLock<T>(
  creatorcutDirectory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = join(creatorcutDirectory, LOCK_FILE);
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = await readFile(lockPath, "utf8")
      .then((value) => JSON.parse(value) as { pid?: number })
      .catch((): { pid?: number } => ({}));
    if (!Number.isSafeInteger(owner.pid)) {
      throw new Error("CreatorCut project has an unreadable operation lock");
    }
    try {
      process.kill(owner.pid!, 0);
      throw new Error(
        "CreatorCut project is locked by another local operation",
      );
    } catch (ownerError) {
      if ((ownerError as NodeJS.ErrnoException).code !== "ESRCH") {
        throw ownerError;
      }
    }
    await rm(lockPath, { force: true });
    handle = await open(lockPath, "wx", 0o600);
  }
  await handle.writeFile(
    JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }),
    "utf8",
  );
  try {
    return await operation();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

function emptyTranscript(project: LocalMediaProject): LocalTranscript {
  return {
    schema_version: "1.0",
    transcript_id: `transcript:${project.project_id}`,
    project_id: project.project_id,
    revision: project.revision,
    language_mode: "auto",
    segments: [],
    silence_intervals: [],
  };
}

function conservativeEditBrief(project: LocalMediaProject): LocalEditBrief {
  return {
    schema_version: "1.0",
    brief_id: `brief:${project.project_id}`,
    project_id: project.project_id,
    base_revision: project.revision,
    audio_mode: "original",
    caption_style_id: "caption_none",
    approved: true,
    source: "safe_local_default",
  };
}

function snapshotOf(opened: OpenedCreatorCutProject): LocalProjectSnapshot {
  return {
    schema_version: "creatorcut-local-snapshot/1.0",
    revision: opened.project.revision,
    project: structuredClone(opened.project),
    timeline: structuredClone(opened.timeline),
    transcript: structuredClone(opened.transcript),
    edit_brief: structuredClone(opened.editBrief),
  };
}

async function writeSnapshot(
  creatorcutDirectory: string,
  snapshot: LocalProjectSnapshot,
): Promise<void> {
  await atomicPrivateJson(
    join(creatorcutDirectory, "versions", `${snapshot.revision}.json`),
    snapshot,
  );
}

async function readHistory(
  creatorcutDirectory: string,
): Promise<LocalRevisionHistory> {
  return (await readJson(
    join(creatorcutDirectory, HISTORY_FILE),
  )) as LocalRevisionHistory;
}

async function writeMirrors(
  creatorcutDirectory: string,
  snapshot: LocalProjectSnapshot,
  history: LocalRevisionHistory,
): Promise<void> {
  await writeSnapshot(creatorcutDirectory, snapshot);
  await atomicPrivateJson(
    join(creatorcutDirectory, "project.json"),
    snapshot.project,
  );
  await atomicPrivateJson(
    join(creatorcutDirectory, "timeline.json"),
    snapshot.timeline,
  );
  await atomicPrivateJson(
    join(creatorcutDirectory, "transcript.json"),
    snapshot.transcript,
  );
  await atomicPrivateJson(
    join(creatorcutDirectory, "edit-brief.json"),
    snapshot.edit_brief,
  );
  await atomicPrivateJson(join(creatorcutDirectory, HISTORY_FILE), history);
}

async function clearRevisionBoundState(
  creatorcutDirectory: string,
): Promise<void> {
  await Promise.all(
    [CONSENT_FILE, REMOTE_STATE_FILE, "preview-confirmation.json"].map((name) =>
      rm(join(creatorcutDirectory, name), { force: true }),
    ),
  );
}

export async function createCreatorCutProject(
  projectDirectory: string,
  input: CreateLocalProjectInput,
): Promise<OpenedCreatorCutProject> {
  const directory = resolve(projectDirectory);
  const creatorcutDirectory = join(directory, ".creatorcut");
  if (
    await access(join(creatorcutDirectory, "project.json"))
      .then(() => true)
      .catch(() => false)
  ) {
    throw new Error("CreatorCut project already exists");
  }
  await mkdir(join(creatorcutDirectory, "versions"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(join(creatorcutDirectory, "tasks"), {
    recursive: true,
    mode: 0o700,
  });
  await Promise.all(
    ["media", "proxies", "generated", "exports"].map((name) =>
      mkdir(join(directory, name), { recursive: true, mode: 0o700 }),
    ),
  );
  const transcript = input.transcript ?? emptyTranscript(input.project);
  const editBrief = input.editBrief ?? conservativeEditBrief(input.project);
  const opened: OpenedCreatorCutProject = {
    directory,
    creatorcutDirectory,
    project: structuredClone(input.project),
    timeline: structuredClone(input.timeline),
    transcript: structuredClone(transcript),
    editBrief: structuredClone(editBrief),
  };
  assertSameRevision(opened);
  await writeMirrors(creatorcutDirectory, snapshotOf(opened), {
    schema_version: "creatorcut-local-history/1.0",
    current_revision: opened.project.revision,
    undo_stack: [],
    redo_stack: [],
  });
  await writeFile(join(creatorcutDirectory, OPERATIONS_FILE), "", {
    encoding: "utf8",
    mode: 0o600,
  });
  return openCreatorCutProject(directory);
}

export async function readLocalArtifact<T>(
  projectDirectory: string,
  relativePath: string,
): Promise<T | null> {
  const opened = await openCreatorCutProject(projectDirectory);
  const path = resolve(opened.creatorcutDirectory, relativePath);
  if (
    path !== opened.creatorcutDirectory &&
    !path.startsWith(`${opened.creatorcutDirectory}/`)
  ) {
    throw new TypeError("CreatorCut artifact path escapes the project");
  }
  try {
    return (await readJson(path)) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeLocalArtifact(
  projectDirectory: string,
  relativePath: string,
  value: unknown,
): Promise<void> {
  const opened = await openCreatorCutProject(projectDirectory);
  const path = resolve(opened.creatorcutDirectory, relativePath);
  if (
    path !== opened.creatorcutDirectory &&
    !path.startsWith(`${opened.creatorcutDirectory}/`)
  ) {
    throw new TypeError("CreatorCut artifact path escapes the project");
  }
  await atomicPrivateJson(path, value);
}

export async function replaceLocalTranscript(
  projectDirectory: string,
  transcript: LocalTranscript,
): Promise<OpenedCreatorCutProject> {
  const opened = await openCreatorCutProject(projectDirectory);
  if (
    transcript.project_id !== opened.project.project_id ||
    transcript.revision !== opened.project.revision
  ) {
    throw new TypeError("Transcript is stale or belongs to another project");
  }
  await atomicPrivateJson(
    join(opened.creatorcutDirectory, "transcript.json"),
    transcript,
  );
  const refreshed = await openCreatorCutProject(projectDirectory);
  await writeSnapshot(refreshed.creatorcutDirectory, snapshotOf(refreshed));
  await clearRevisionBoundState(refreshed.creatorcutDirectory);
  return refreshed;
}

export async function commitLocalRevision(
  projectDirectory: string,
  input: CommitLocalRevisionInput,
  now = new Date(),
): Promise<OpenedCreatorCutProject> {
  const initial = await openCreatorCutProject(projectDirectory);
  return withProjectLock(initial.creatorcutDirectory, async () => {
    const opened = await openCreatorCutProject(projectDirectory);
    if (opened.project.revision !== input.baseRevision) {
      throw new Error(
        `Project revision conflict: expected ${input.baseRevision}, current ${opened.project.revision}`,
      );
    }
    const history = await readHistory(opened.creatorcutDirectory);
    const nextRevision = opened.project.revision + 1;
    const project: LocalMediaProject = {
      ...structuredClone(opened.project),
      revision: nextRevision,
      updated_at: now.toISOString(),
    };
    const timeline: LocalTimeline = {
      ...structuredClone(input.nextTimeline),
      project_id: project.project_id,
      revision: nextRevision,
    };
    const snapshot: LocalProjectSnapshot = {
      schema_version: "creatorcut-local-snapshot/1.0",
      revision: nextRevision,
      project,
      timeline,
      transcript: {
        ...structuredClone(opened.transcript),
        revision: nextRevision,
      },
      edit_brief: {
        ...structuredClone(opened.editBrief),
        base_revision: nextRevision,
      },
    };
    const nextHistory: LocalRevisionHistory = {
      schema_version: "creatorcut-local-history/1.0",
      current_revision: nextRevision,
      undo_stack: [...history.undo_stack, opened.project.revision],
      redo_stack: [],
    };
    await writeMirrors(opened.creatorcutDirectory, snapshot, nextHistory);
    const log: LocalOperationLogEntry = {
      schema_version: "creatorcut-local-operation-log/1.0",
      revision: nextRevision,
      base_revision: opened.project.revision,
      operation_ids: [...input.operationIds],
      ...(input.manifestDigest
        ? { manifest_digest: input.manifestDigest }
        : {}),
      committed_at: now.toISOString(),
    };
    await appendFile(
      join(opened.creatorcutDirectory, OPERATIONS_FILE),
      `${JSON.stringify(log)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await clearRevisionBoundState(opened.creatorcutDirectory);
    return openCreatorCutProject(projectDirectory);
  });
}

async function restoreHistoricalRevision(
  projectDirectory: string,
  direction: "undo" | "redo",
  now = new Date(),
): Promise<OpenedCreatorCutProject> {
  const initial = await openCreatorCutProject(projectDirectory);
  return withProjectLock(initial.creatorcutDirectory, async () => {
    const opened = await openCreatorCutProject(projectDirectory);
    const history = await readHistory(opened.creatorcutDirectory);
    const sourceStack =
      direction === "undo" ? history.undo_stack : history.redo_stack;
    const targetRevision = sourceStack.at(-1);
    if (targetRevision === undefined) {
      throw new Error(`No ${direction} revision is available`);
    }
    const target = (await readJson(
      join(opened.creatorcutDirectory, "versions", `${targetRevision}.json`),
    )) as LocalProjectSnapshot;
    const nextRevision = opened.project.revision + 1;
    const snapshot: LocalProjectSnapshot = {
      ...structuredClone(target),
      revision: nextRevision,
      project: {
        ...structuredClone(target.project),
        revision: nextRevision,
        updated_at: now.toISOString(),
      },
      timeline: {
        ...structuredClone(target.timeline),
        revision: nextRevision,
      },
      transcript: {
        ...structuredClone(target.transcript),
        revision: nextRevision,
      },
      edit_brief: {
        ...structuredClone(target.edit_brief),
        base_revision: nextRevision,
      },
    };
    const nextHistory: LocalRevisionHistory =
      direction === "undo"
        ? {
            schema_version: "creatorcut-local-history/1.0",
            current_revision: nextRevision,
            undo_stack: history.undo_stack.slice(0, -1),
            redo_stack: [...history.redo_stack, opened.project.revision],
          }
        : {
            schema_version: "creatorcut-local-history/1.0",
            current_revision: nextRevision,
            undo_stack: [...history.undo_stack, opened.project.revision],
            redo_stack: history.redo_stack.slice(0, -1),
          };
    await writeMirrors(opened.creatorcutDirectory, snapshot, nextHistory);
    await appendFile(
      join(opened.creatorcutDirectory, OPERATIONS_FILE),
      `${JSON.stringify({
        schema_version: "creatorcut-local-operation-log/1.0",
        revision: nextRevision,
        base_revision: opened.project.revision,
        operation_ids: [`local:${direction}:${targetRevision}`],
        committed_at: now.toISOString(),
      } satisfies LocalOperationLogEntry)}\n`,
      "utf8",
    );
    await clearRevisionBoundState(opened.creatorcutDirectory);
    return openCreatorCutProject(projectDirectory);
  });
}

export function undoLocalRevision(
  projectDirectory: string,
): Promise<OpenedCreatorCutProject> {
  return restoreHistoricalRevision(projectDirectory, "undo");
}

export function redoLocalRevision(
  projectDirectory: string,
): Promise<OpenedCreatorCutProject> {
  return restoreHistoricalRevision(projectDirectory, "redo");
}

export async function approveDirectorContext(
  opened: OpenedCreatorCutProject,
  context: DirectorContext,
  now = new Date(),
): Promise<DirectorConsentRecord> {
  const inspection = inspectDirectorContext(context);
  if (
    inspection.project_id !== opened.project.project_id ||
    inspection.base_revision !== opened.project.revision
  ) {
    throw new TypeError("Consent context is stale");
  }
  const record: DirectorConsentRecord = {
    schema_version: "creatorcut-director-consent/1.0",
    consent_version: context.consent_version,
    project_id: context.project_id,
    base_revision: context.base_revision,
    planning_input_digest: inspection.planning_input_digest,
    transcript_digest: context.transcript_digest,
    upload_bytes: inspection.upload_bytes,
    approved_at: now.toISOString(),
  };
  await atomicPrivateJson(
    join(opened.creatorcutDirectory, CONSENT_FILE),
    record,
  );
  return record;
}

export async function readDirectorConsent(
  opened: OpenedCreatorCutProject,
): Promise<DirectorConsentRecord | null> {
  try {
    const value = await readJson(
      join(opened.creatorcutDirectory, CONSENT_FILE),
    );
    return value as DirectorConsentRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function requireDirectorConsent(
  opened: OpenedCreatorCutProject,
  context: DirectorContext,
): Promise<DirectorConsentRecord> {
  const record = await readDirectorConsent(opened);
  if (
    !record ||
    record.schema_version !== "creatorcut-director-consent/1.0" ||
    record.project_id !== context.project_id ||
    record.base_revision !== context.base_revision ||
    record.consent_version !== context.consent_version ||
    record.planning_input_digest !== digestJcs(context) ||
    record.transcript_digest !== context.transcript_digest
  ) {
    throw new Error(
      "DirectorContext upload is not approved for the current project revision",
    );
  }
  return record;
}

export async function revokeDirectorConsent(
  opened: OpenedCreatorCutProject,
): Promise<void> {
  await rm(join(opened.creatorcutDirectory, CONSENT_FILE), { force: true });
}

export async function readDirectorState<T>(
  opened: OpenedCreatorCutProject,
): Promise<T | null> {
  try {
    return (await readJson(
      join(opened.creatorcutDirectory, REMOTE_STATE_FILE),
    )) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeDirectorState<T>(
  opened: OpenedCreatorCutProject,
  value: T,
): Promise<void> {
  await atomicPrivateJson(
    join(opened.creatorcutDirectory, REMOTE_STATE_FILE),
    value,
  );
}

export async function clearDirectorState(
  opened: OpenedCreatorCutProject,
): Promise<void> {
  await rm(join(opened.creatorcutDirectory, REMOTE_STATE_FILE), {
    force: true,
  });
}
