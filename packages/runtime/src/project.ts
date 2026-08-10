import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
import { withCreatorCutProjectLock } from "./project-lock.js";
import {
  initializePublicStorageAuthorityForCreate,
  validatePublicStorageAuthorityUnlocked,
  withPublicStorageMutation,
} from "./storage-authority.js";
import {
  assertKnownLocalArtifactPath,
  validateLocalArtifact,
} from "./artifact-schema.js";
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
  LocalVisualComposition,
  OpenedCreatorCutProject,
} from "./types.js";

const PUBLIC_PROTOCOL_VERSION = "1.0";
const DEFAULT_CONSENT_VERSION = "director-context-consent-v1";
const CONSENT_FILE = "director-consent.json";
const REMOTE_STATE_FILE = "director-state.json";
const HISTORY_FILE = "history.json";
const OPERATIONS_FILE = "operations.jsonl";
const VISUAL_COMPOSITION_FILE = "visual-composition.json";

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
  if (typeof editBrief.approved !== "boolean") {
    throw new TypeError("edit_brief.approved must be boolean");
  }
  return editBrief as unknown as LocalEditBrief;
}

function assertVisualComposition(value: unknown): LocalVisualComposition {
  const composition = requireRecord(value, "visual composition");
  requireString(
    composition.composition_id,
    "visual_composition.composition_id",
  );
  requireString(composition.project_id, "visual_composition.project_id");
  requireString(composition.timeline_id, "visual_composition.timeline_id");
  requireInteger(
    composition.rough_cut_revision,
    "visual_composition.rough_cut_revision",
  );
  requireInteger(
    composition.project_revision,
    "visual_composition.project_revision",
  );
  if (!["active", "needs_rebase"].includes(String(composition.state))) {
    throw new TypeError(
      "visual_composition.state must be active or needs_rebase",
    );
  }
  if (!Array.isArray(composition.visual_events)) {
    throw new TypeError("visual_composition.visual_events must be an array");
  }
  requireRecord(composition.provenance, "visual_composition.provenance");
  return composition as unknown as LocalVisualComposition;
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

async function readOpenedProjectUnlocked(
  directory: string,
  authorityGeneration: number,
): Promise<OpenedCreatorCutProject> {
  const creatorcutDirectory = join(directory, ".creatorcut");
  const visualComposition = await readJson(
    join(creatorcutDirectory, VISUAL_COMPOSITION_FILE),
  )
    .then(assertVisualComposition)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  const project: OpenedCreatorCutProject = {
    directory,
    creatorcutDirectory,
    authorityGeneration,
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
    ...(visualComposition ? { visualComposition } : {}),
  };
  assertSameRevision(project);
  if (
    project.visualComposition &&
    (project.visualComposition.project_id !== project.project.project_id ||
      project.visualComposition.timeline_id !== project.timeline.timeline_id ||
      project.visualComposition.project_revision !== project.project.revision)
  ) {
    throw new TypeError(
      "Visual composition is stale or belongs to another project",
    );
  }
  return project;
}

async function openCreatorCutProjectUnlocked(
  directory: string,
): Promise<OpenedCreatorCutProject> {
  const creatorcutDirectory = join(directory, ".creatorcut");
  const marker =
    await validatePublicStorageAuthorityUnlocked(creatorcutDirectory);
  return readOpenedProjectUnlocked(directory, marker.generation);
}

export async function openCreatorCutProject(
  projectDirectory: string,
): Promise<OpenedCreatorCutProject> {
  const directory = await realpath(resolve(projectDirectory));
  const creatorcutDirectory = join(directory, ".creatorcut");
  return withCreatorCutProjectLock(creatorcutDirectory, () =>
    openCreatorCutProjectUnlocked(directory),
  );
}

async function withPublicMutation<T>(
  projectDirectory: string,
  mutationKind: string,
  operation: (
    opened: OpenedCreatorCutProject,
  ) => Promise<{ value: T; revision: number }>,
): Promise<T> {
  const directory = await realpath(resolve(projectDirectory));
  const creatorcutDirectory = join(directory, ".creatorcut");
  const completed = await withPublicStorageMutation(
    creatorcutDirectory,
    mutationKind,
    async (marker) => {
      const opened = await readOpenedProjectUnlocked(
        directory,
        marker.generation,
      );
      const result = await operation(opened);
      return {
        value: result.value,
        currentRevision: result.revision,
      };
    },
  );
  if (
    completed.value !== null &&
    typeof completed.value === "object" &&
    "authorityGeneration" in completed.value
  ) {
    (
      completed.value as unknown as OpenedCreatorCutProject
    ).authorityGeneration = completed.marker.generation;
  }
  return completed.value;
}

export function buildDirectorContext(
  opened: OpenedCreatorCutProject,
  options: BuildDirectorContextOptions = {},
): DirectorContext {
  if (!opened.editBrief.approved) {
    throw new TypeError("Cloud Director requires an approved edit brief");
  }
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

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    try {
      await handle.sync();
    } catch (error) {
      // Node's Windows backend opens directories for reading but does not
      // expose a FlushFileBuffers-capable directory handle. File contents are
      // synced before rename; sudden-power-loss durability remains outside the
      // RC contract, while process-crash recovery still uses the renamed WAL.
      if (
        platform() !== "win32" ||
        (error as NodeJS.ErrnoException).code !== "EPERM"
      ) {
        throw error;
      }
    }
  } finally {
    await handle.close();
  }
}

async function atomicPrivateText(
  path: string,
  contents: string,
): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(parent);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function atomicPrivateJson(path: string, value: unknown): Promise<void> {
  await atomicPrivateText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function durableAppendJsonLine(
  path: string,
  value: unknown,
): Promise<void> {
  const existing = await readFile(path, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  await atomicPrivateText(path, `${existing}${JSON.stringify(value)}\n`);
}

async function durableRemove(path: string): Promise<void> {
  await rm(path, { force: true });
  await syncDirectory(dirname(path));
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
    ...(opened.visualComposition
      ? { visual_composition: structuredClone(opened.visualComposition) }
      : {}),
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
  if (snapshot.visual_composition) {
    await atomicPrivateJson(
      join(creatorcutDirectory, VISUAL_COMPOSITION_FILE),
      snapshot.visual_composition,
    );
  } else {
    await durableRemove(join(creatorcutDirectory, VISUAL_COMPOSITION_FILE));
  }
}

async function clearRevisionBoundState(
  creatorcutDirectory: string,
): Promise<void> {
  for (const name of [
    CONSENT_FILE,
    REMOTE_STATE_FILE,
    "preview-confirmation.json",
  ]) {
    await durableRemove(join(creatorcutDirectory, name));
  }
}

export async function createCreatorCutProject(
  projectDirectory: string,
  input: CreateLocalProjectInput,
): Promise<OpenedCreatorCutProject> {
  const directory = resolve(projectDirectory);
  const creatorcutDirectory = join(directory, ".creatorcut");
  await mkdir(creatorcutDirectory, { recursive: true, mode: 0o700 });
  return withCreatorCutProjectLock(creatorcutDirectory, async () => {
    const existing = (await readdir(creatorcutDirectory)).filter(
      (name) => !["project.lock", "project.lock.recovery"].includes(name),
    );
    if (existing.length > 0) {
      throw new Error("CreatorCut project already exists or is incomplete");
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
      authorityGeneration: 0,
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
    await atomicPrivateText(join(creatorcutDirectory, OPERATIONS_FILE), "");
    const marker = await initializePublicStorageAuthorityForCreate(
      creatorcutDirectory,
      opened.project.project_id,
      opened.project.revision,
    );
    return readOpenedProjectUnlocked(directory, marker.generation);
  });
}

export async function readLocalArtifact<T>(
  projectDirectory: string,
  relativePath: string,
): Promise<T | null> {
  const directory = await realpath(resolve(projectDirectory));
  const creatorcutDirectory = join(directory, ".creatorcut");
  return withCreatorCutProjectLock(creatorcutDirectory, async () => {
    const opened = await openCreatorCutProjectUnlocked(directory);
    const path = safeArtifactPath(creatorcutDirectory, relativePath);
    try {
      const value = validateLocalArtifact(
        relativePath,
        await readArtifactJsonNoFollow(creatorcutDirectory, path),
      );
      assertArtifactProjectBinding(relativePath, value, opened);
      return value as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  });
}

function assertArtifactProjectBinding(
  relativePath: string,
  value: unknown,
  opened: OpenedCreatorCutProject,
): void {
  const artifact = value as Record<string, unknown>;
  if (
    typeof artifact.project_id === "string" &&
    artifact.project_id !== opened.project.project_id
  ) {
    throw new TypeError(
      `CreatorCut artifact belongs to another project: ${relativePath}`,
    );
  }
  const revision = artifact.base_revision;
  if (revision !== undefined && revision !== opened.project.revision) {
    throw new TypeError(`CreatorCut artifact is stale: ${relativePath}`);
  }
}

function safeArtifactPath(
  creatorcutDirectory: string,
  relativePath: string,
): string {
  assertSafeArtifactRelativePath(relativePath);
  const path = resolve(creatorcutDirectory, relativePath);
  const fromRoot = relative(creatorcutDirectory, path);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new TypeError("CreatorCut artifact path escapes the project");
  }
  return path;
}

function assertSafeArtifactRelativePath(relativePath: string): void {
  if (
    relativePath.includes("\\") ||
    relativePath.startsWith("/") ||
    relativePath.split("/").includes("..")
  ) {
    throw new TypeError("CreatorCut artifact path escapes the project");
  }
  assertKnownLocalArtifactPath(relativePath);
}

type ArtifactParentIdentity = {
  creatorcutDirectory: string;
  creatorcutRealPath: string;
  creatorcutDevice: number;
  creatorcutInode: number;
  parentDirectory: string;
  parentRealPath: string;
  parentDevice: number;
  parentInode: number;
};

const MAX_LOCAL_ARTIFACT_BYTES = 16 * 1024 * 1024;

function isContainedPath(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return !(
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  );
}

async function captureArtifactParentIdentity(
  creatorcutDirectory: string,
  artifactPath: string,
): Promise<ArtifactParentIdentity> {
  const creatorcutStat = await lstat(creatorcutDirectory);
  if (!creatorcutStat.isDirectory() || creatorcutStat.isSymbolicLink()) {
    throw new Error(
      "CreatorCut artifact state root is not a trusted directory",
    );
  }
  const creatorcutRealPath = await realpath(creatorcutDirectory);
  const parentDirectory = dirname(artifactPath);
  const parentStat = await lstat(parentDirectory);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("CreatorCut artifact parent is not a trusted directory");
  }
  const parentRealPath = await realpath(parentDirectory);
  if (!isContainedPath(creatorcutRealPath, parentRealPath)) {
    throw new Error("CreatorCut artifact parent escapes the project state");
  }
  return {
    creatorcutDirectory,
    creatorcutRealPath,
    creatorcutDevice: creatorcutStat.dev,
    creatorcutInode: creatorcutStat.ino,
    parentDirectory,
    parentRealPath,
    parentDevice: parentStat.dev,
    parentInode: parentStat.ino,
  };
}

async function ensureArtifactParentDirectory(
  creatorcutDirectory: string,
  artifactPath: string,
): Promise<void> {
  const parentDirectory = dirname(artifactPath);
  if (parentDirectory === creatorcutDirectory) return;
  if (relative(creatorcutDirectory, parentDirectory) !== "tasks") {
    throw new Error("CreatorCut artifact parent is outside the fixed registry");
  }
  const creatorcutStat = await lstat(creatorcutDirectory);
  if (!creatorcutStat.isDirectory() || creatorcutStat.isSymbolicLink()) {
    throw new Error(
      "CreatorCut artifact state root is not a trusted directory",
    );
  }
  const creatorcutRealPath = await realpath(creatorcutDirectory);
  try {
    await lstat(parentDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await mkdir(parentDirectory, { mode: 0o700 });
      await syncDirectory(creatorcutDirectory);
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
        throw mkdirError;
      }
    }
  }
  const creatorcutAfter = await lstat(creatorcutDirectory);
  if (
    !creatorcutAfter.isDirectory() ||
    creatorcutAfter.isSymbolicLink() ||
    creatorcutAfter.dev !== creatorcutStat.dev ||
    creatorcutAfter.ino !== creatorcutStat.ino ||
    (await realpath(creatorcutDirectory)) !== creatorcutRealPath
  ) {
    throw new Error("CreatorCut artifact state root changed during setup");
  }
}

async function assertArtifactParentIdentity(
  identity: ArtifactParentIdentity,
): Promise<void> {
  const creatorcutStat = await lstat(identity.creatorcutDirectory);
  const parentStat = await lstat(identity.parentDirectory);
  if (
    !creatorcutStat.isDirectory() ||
    creatorcutStat.isSymbolicLink() ||
    creatorcutStat.dev !== identity.creatorcutDevice ||
    creatorcutStat.ino !== identity.creatorcutInode ||
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    parentStat.dev !== identity.parentDevice ||
    parentStat.ino !== identity.parentInode ||
    (await realpath(identity.creatorcutDirectory)) !==
      identity.creatorcutRealPath ||
    (await realpath(identity.parentDirectory)) !== identity.parentRealPath
  ) {
    throw new Error("CreatorCut artifact parent changed during access");
  }
}

async function readArtifactJsonNoFollow(
  creatorcutDirectory: string,
  artifactPath: string,
): Promise<unknown> {
  const identity = await captureArtifactParentIdentity(
    creatorcutDirectory,
    artifactPath,
  );
  await assertArtifactParentIdentity(identity);
  const handle = await open(
    artifactPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size > MAX_LOCAL_ARTIFACT_BYTES ||
      before.size < 0
    ) {
      throw new Error("CreatorCut artifact is not a bounded regular file");
    }
    const contents = await handle.readFile();
    const after = await handle.stat();
    const pathStat = await lstat(artifactPath);
    if (
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      pathStat.isSymbolicLink() ||
      pathStat.dev !== after.dev ||
      pathStat.ino !== after.ino ||
      contents.byteLength !== after.size
    ) {
      throw new Error("CreatorCut artifact changed during read");
    }
    await assertArtifactParentIdentity(identity);
    return JSON.parse(contents.toString("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

async function cleanupOwnedArtifactTemporary(
  identity: ArtifactParentIdentity,
  temporaryPath: string,
  temporaryDevice: number | undefined,
  temporaryInode: number | undefined,
): Promise<void> {
  if (temporaryDevice === undefined || temporaryInode === undefined) return;
  try {
    await assertArtifactParentIdentity(identity);
    const current = await lstat(temporaryPath);
    if (
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.dev === temporaryDevice &&
      current.ino === temporaryInode
    ) {
      await unlink(temporaryPath);
      await syncDirectory(identity.parentDirectory);
    }
  } catch {
    // Never remove a path unless both its parent and inode are still ours.
  }
}

async function atomicArtifactJson(
  creatorcutDirectory: string,
  artifactPath: string,
  value: unknown,
): Promise<void> {
  await ensureArtifactParentDirectory(creatorcutDirectory, artifactPath);
  const identity = await captureArtifactParentIdentity(
    creatorcutDirectory,
    artifactPath,
  );
  const temporaryPath = join(
    identity.parentDirectory,
    `.${randomUUID()}.artifact.tmp`,
  );
  let handle;
  let temporaryDevice: number | undefined;
  let temporaryInode: number | undefined;
  try {
    await assertArtifactParentIdentity(identity);
    handle = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const temporaryStat = await handle.stat();
    temporaryDevice = temporaryStat.dev;
    temporaryInode = temporaryStat.ino;
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertArtifactParentIdentity(identity);
    const publishedTemporary = await lstat(temporaryPath);
    if (
      publishedTemporary.isSymbolicLink() ||
      publishedTemporary.dev !== temporaryDevice ||
      publishedTemporary.ino !== temporaryInode
    ) {
      throw new Error("CreatorCut artifact temporary changed before publish");
    }
    await rename(temporaryPath, artifactPath);
    temporaryDevice = undefined;
    temporaryInode = undefined;
    await assertArtifactParentIdentity(identity);
    const published = await lstat(artifactPath);
    if (!published.isFile() || published.isSymbolicLink()) {
      throw new Error("CreatorCut artifact publish target is unsafe");
    }
    await syncDirectory(identity.parentDirectory);
    await assertArtifactParentIdentity(identity);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await cleanupOwnedArtifactTemporary(
      identity,
      temporaryPath,
      temporaryDevice,
      temporaryInode,
    );
    throw error;
  }
}

export async function writeLocalArtifact(
  projectDirectory: string,
  relativePath: string,
  value: unknown,
): Promise<void> {
  assertSafeArtifactRelativePath(relativePath);
  const validated = validateLocalArtifact(relativePath, value);
  await withPublicMutation(
    projectDirectory,
    "artifact_write",
    async (opened) => {
      assertArtifactProjectBinding(relativePath, validated, opened);
      await atomicArtifactJson(
        opened.creatorcutDirectory,
        safeArtifactPath(opened.creatorcutDirectory, relativePath),
        validateLocalArtifact(relativePath, validated),
      );
      return { value: undefined, revision: opened.project.revision };
    },
  );
}

export function localArtifactDigest(value: unknown): string {
  return digestJcs(value);
}

export async function compareAndSwapLocalArtifact<T, V>(
  projectDirectory: string,
  relativePath: string,
  expectation: {
    projectId: string;
    revision: number;
    authorityGeneration: number;
    artifactDigest: string;
    mutationKind?: string;
  },
  operation: (input: {
    opened: OpenedCreatorCutProject;
    currentArtifact: T | null;
  }) => Promise<{
    nextArtifact: T;
    value: V;
    nextTranscript?: LocalTranscript;
  }>,
): Promise<{ artifact: T; value: V; authorityGeneration: number }> {
  assertSafeArtifactRelativePath(relativePath);
  const directory = await realpath(resolve(projectDirectory));
  const creatorcutDirectory = join(directory, ".creatorcut");
  const completed = await withPublicStorageMutation(
    creatorcutDirectory,
    expectation.mutationKind ?? "artifact_compare_and_swap",
    async (marker) => {
      const opened = await readOpenedProjectUnlocked(
        directory,
        marker.generation,
      );
      if (
        marker.generation !== expectation.authorityGeneration ||
        opened.project.project_id !== expectation.projectId ||
        opened.project.revision !== expectation.revision
      ) {
        throw new Error(
          "CreatorCut artifact compare-and-swap authority changed",
        );
      }
      const path = safeArtifactPath(creatorcutDirectory, relativePath);
      const currentArtifact = await readArtifactJsonNoFollow(
        creatorcutDirectory,
        path,
      )
        .then((value) => validateLocalArtifact(relativePath, value))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      if (digestJcs(currentArtifact) !== expectation.artifactDigest) {
        throw new Error("CreatorCut artifact compare-and-swap state changed");
      }
      if (currentArtifact !== null) {
        assertArtifactProjectBinding(relativePath, currentArtifact, opened);
      }
      const result = await operation({
        opened,
        currentArtifact: currentArtifact as T | null,
      });
      const nextArtifact = validateLocalArtifact(
        relativePath,
        result.nextArtifact,
      ) as T;
      assertArtifactProjectBinding(relativePath, nextArtifact, opened);
      if (result.nextTranscript) {
        await replaceLocalTranscriptUnlocked(opened, result.nextTranscript);
      }
      await atomicArtifactJson(creatorcutDirectory, path, nextArtifact);
      return {
        value: { artifact: nextArtifact, value: result.value },
        currentRevision: opened.project.revision,
      };
    },
  );
  return {
    ...completed.value,
    authorityGeneration: completed.marker.generation,
  };
}

async function replaceLocalTranscriptUnlocked(
  opened: OpenedCreatorCutProject,
  transcript: LocalTranscript,
): Promise<OpenedCreatorCutProject> {
  const validated = assertTranscript(transcript);
  if (
    validated.project_id !== opened.project.project_id ||
    validated.revision !== opened.project.revision
  ) {
    throw new TypeError("Transcript is stale or belongs to another project");
  }
  await atomicPrivateJson(
    join(opened.creatorcutDirectory, "transcript.json"),
    validated,
  );
  const refreshed = await readOpenedProjectUnlocked(
    opened.directory,
    opened.authorityGeneration,
  );
  const currentSnapshotValue = requireRecord(
    await readJson(
      join(
        refreshed.creatorcutDirectory,
        "versions",
        `${refreshed.project.revision}.json`,
      ),
    ),
    "current project snapshot",
  );
  if (currentSnapshotValue.revision !== refreshed.project.revision) {
    throw new TypeError("Current project snapshot revision is invalid");
  }
  const restoredFromRevision =
    currentSnapshotValue.restored_from_revision === undefined
      ? undefined
      : requireInteger(
          currentSnapshotValue.restored_from_revision,
          "current project snapshot.restored_from_revision",
        );
  await writeSnapshot(refreshed.creatorcutDirectory, {
    ...snapshotOf(refreshed),
    ...(restoredFromRevision === undefined
      ? {}
      : { restored_from_revision: restoredFromRevision }),
  });
  await clearRevisionBoundState(refreshed.creatorcutDirectory);
  return refreshed;
}

export async function replaceLocalTranscript(
  projectDirectory: string,
  transcript: LocalTranscript,
): Promise<OpenedCreatorCutProject> {
  return withPublicMutation(
    projectDirectory,
    "transcript_replace",
    async (opened) => {
      const refreshed = await replaceLocalTranscriptUnlocked(
        opened,
        transcript,
      );
      return { value: refreshed, revision: refreshed.project.revision };
    },
  );
}

export async function commitLocalRevision(
  projectDirectory: string,
  input: CommitLocalRevisionInput,
  now = new Date(),
): Promise<OpenedCreatorCutProject> {
  return withPublicMutation(
    projectDirectory,
    "revision_commit",
    async (opened) => {
      if (opened.project.revision !== input.baseRevision) {
        throw new Error(
          `Project revision conflict: expected ${input.baseRevision}, current ${opened.project.revision}`,
        );
      }
      const history = await readHistory(opened.creatorcutDirectory);
      const nextRevision = opened.project.revision + 1;
      if (
        input.nextProject &&
        input.nextProject.project_id !== opened.project.project_id
      ) {
        throw new TypeError(
          "Next project belongs to another CreatorCut project",
        );
      }
      if (
        input.nextEditBrief &&
        input.nextEditBrief.project_id !== opened.project.project_id
      ) {
        throw new TypeError(
          "Next EditBrief belongs to another CreatorCut project",
        );
      }
      const project: LocalMediaProject = {
        ...structuredClone(input.nextProject ?? opened.project),
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
          ...structuredClone(input.nextEditBrief ?? opened.editBrief),
          project_id: project.project_id,
          base_revision: nextRevision,
        },
        ...(opened.visualComposition
          ? {
              visual_composition: {
                ...structuredClone(opened.visualComposition),
                project_revision: nextRevision,
                state: "needs_rebase",
              },
            }
          : {}),
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
        kind: "commit",
        revision: nextRevision,
        base_revision: opened.project.revision,
        operation_ids: [...input.operationIds],
        ...(input.manifestDigest
          ? { manifest_digest: input.manifestDigest }
          : {}),
        committed_at: now.toISOString(),
      };
      await durableAppendJsonLine(
        join(opened.creatorcutDirectory, OPERATIONS_FILE),
        log,
      );
      await clearRevisionBoundState(opened.creatorcutDirectory);
      const committed = await readOpenedProjectUnlocked(
        opened.directory,
        opened.authorityGeneration,
      );
      return { value: committed, revision: committed.project.revision };
    },
  );
}

async function restoreHistoricalRevision(
  projectDirectory: string,
  direction: "undo" | "redo",
  now = new Date(),
): Promise<OpenedCreatorCutProject> {
  return withPublicMutation(
    projectDirectory,
    `revision_${direction}`,
    async (opened) => {
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
        ...(target.visual_composition
          ? {
              visual_composition: {
                ...structuredClone(target.visual_composition),
                project_revision: nextRevision,
              },
            }
          : {}),
        restored_from_revision: targetRevision,
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
      await durableAppendJsonLine(
        join(opened.creatorcutDirectory, OPERATIONS_FILE),
        {
          schema_version: "creatorcut-local-operation-log/1.0",
          kind: direction,
          revision: nextRevision,
          base_revision: opened.project.revision,
          restored_from_revision: targetRevision,
          operation_ids: [`local:${direction}:${targetRevision}`],
          committed_at: now.toISOString(),
        } satisfies LocalOperationLogEntry,
      );
      await clearRevisionBoundState(opened.creatorcutDirectory);
      const restored = await readOpenedProjectUnlocked(
        opened.directory,
        opened.authorityGeneration,
      );
      return { value: restored, revision: restored.project.revision };
    },
  );
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
  return withPublicMutation(
    opened.directory,
    "director_consent_approve",
    async (current) => {
      if (
        current.project.project_id !== opened.project.project_id ||
        current.project.revision !== opened.project.revision ||
        current.authorityGeneration !== opened.authorityGeneration
      ) {
        throw new TypeError("Consent project changed before approval");
      }
      await atomicPrivateJson(
        join(current.creatorcutDirectory, CONSENT_FILE),
        record,
      );
      return { value: record, revision: current.project.revision };
    },
  );
}

export async function readDirectorConsent(
  opened: OpenedCreatorCutProject,
): Promise<DirectorConsentRecord | null> {
  return withCreatorCutProjectLock(opened.creatorcutDirectory, async () => {
    const marker = await validatePublicStorageAuthorityUnlocked(
      opened.creatorcutDirectory,
    );
    if (
      marker.project_id !== opened.project.project_id ||
      marker.current_revision !== opened.project.revision
    ) {
      throw new Error(
        "Director consent read is stale for current authority state",
      );
    }
    try {
      const value = await readJson(
        join(opened.creatorcutDirectory, CONSENT_FILE),
      );
      return value as DirectorConsentRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  });
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
  await withPublicMutation(
    opened.directory,
    "director_consent_revoke",
    async (current) => {
      if (
        current.project.revision !== opened.project.revision ||
        current.authorityGeneration !== opened.authorityGeneration
      ) {
        throw new Error("Director consent revoke is stale");
      }
      await durableRemove(join(current.creatorcutDirectory, CONSENT_FILE));
      return { value: undefined, revision: current.project.revision };
    },
  );
}

export async function readDirectorState<T>(
  opened: OpenedCreatorCutProject,
): Promise<T | null> {
  return withCreatorCutProjectLock(opened.creatorcutDirectory, async () => {
    const marker = await validatePublicStorageAuthorityUnlocked(
      opened.creatorcutDirectory,
    );
    if (
      marker.project_id !== opened.project.project_id ||
      marker.current_revision !== opened.project.revision ||
      marker.generation !== opened.authorityGeneration
    ) {
      throw new Error(
        "Director state read is stale for current authority state",
      );
    }
    try {
      return (await readJson(
        join(opened.creatorcutDirectory, REMOTE_STATE_FILE),
      )) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  });
}

export async function writeDirectorState<T>(
  opened: OpenedCreatorCutProject,
  value: T,
): Promise<void> {
  await withPublicMutation(
    opened.directory,
    "director_state_write",
    async (current) => {
      if (
        current.project.project_id !== opened.project.project_id ||
        current.project.revision !== opened.project.revision ||
        current.authorityGeneration !== opened.authorityGeneration
      ) {
        throw new Error(
          "Director response is stale for the current project revision or authority generation",
        );
      }
      await atomicPrivateJson(
        join(current.creatorcutDirectory, REMOTE_STATE_FILE),
        value,
      );
      return { value: undefined, revision: current.project.revision };
    },
  );
}

export async function clearDirectorState(
  opened: OpenedCreatorCutProject,
): Promise<void> {
  await withPublicMutation(
    opened.directory,
    "director_state_clear",
    async (current) => {
      if (
        current.project.revision !== opened.project.revision ||
        current.authorityGeneration !== opened.authorityGeneration
      ) {
        throw new Error("Director state clear is stale");
      }
      await durableRemove(join(current.creatorcutDirectory, REMOTE_STATE_FILE));
      return { value: undefined, revision: current.project.revision };
    },
  );
}
