import { randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  assertPublicProtocol,
  digestJcs,
  type DirectorEnvelope,
  type EditDecisionManifest,
} from "@agentmesh/creatorcut-protocol";
import {
  commitLocalRevision,
  openCreatorCutProject,
  readLocalArtifact,
  writeLocalArtifact,
} from "@agentmesh/creatorcut-runtime";

import { sha256File } from "./import.js";
import { materializeFinishing } from "./finishing.js";
import { applyEditOperations } from "./operations.js";
import { renderTimeline } from "./render.js";
import type {
  ApplyManifestResult,
  MediaToolOptions,
  PreviewRecord,
  RenderTimelineResult,
} from "./types.js";

function assertManifestBinding(
  opened: Awaited<ReturnType<typeof openCreatorCutProject>>,
  envelope: DirectorEnvelope<EditDecisionManifest>,
): EditDecisionManifest {
  const manifest = assertPublicProtocol<EditDecisionManifest>(
    "edit-decision-manifest",
    envelope.payload,
  );
  if (
    envelope.artifact_type !== "edit_manifest" ||
    envelope.project_id !== opened.project.project_id ||
    envelope.base_revision !== opened.project.revision
  ) {
    throw new Error(
      "Signed CreatorCut Manifest is stale or belongs to another project",
    );
  }
  const required = new Set(manifest.required_operation_types);
  for (const operation of manifest.operations) {
    if (!required.has(operation.operation_type)) {
      throw new Error("Manifest required_operation_types omits an operation");
    }
  }
  return manifest;
}

export async function previewSignedManifest(
  projectDirectory: string,
  envelope: DirectorEnvelope<EditDecisionManifest>,
  outputPath?: string,
  options: MediaToolOptions = {},
): Promise<{ preview: RenderTimelineResult; confirmation: PreviewRecord }> {
  const opened = await openCreatorCutProject(projectDirectory);
  const manifest = assertManifestBinding(opened, envelope);
  const timeline = applyEditOperations({
    project: opened.project,
    timeline: opened.timeline,
    operations: manifest.operations,
  });
  const manifestDigest = digestJcs(envelope);
  const materialized = await materializeFinishing(
    opened,
    timeline,
    manifest.finishing,
    manifestDigest,
  );
  const previewPath = resolve(
    outputPath ??
      join(
        opened.creatorcutDirectory,
        "previews",
        `${manifest.manifest_id}.mp4`,
      ),
  );
  await mkdir(dirname(previewPath), { recursive: true, mode: 0o700 });
  const preview = await renderTimeline({
    ...options,
    projectDirectory: opened.directory,
    project: materialized.project,
    timeline: materialized.timeline,
    outputPath: previewPath,
    quality: "preview",
    overwrite: true,
  });
  const confirmation: PreviewRecord = {
    schema_version: "creatorcut-preview-confirmation/1.0",
    project_id: opened.project.project_id,
    base_revision: opened.project.revision,
    manifest_digest: manifestDigest,
    planned_project_digest: digestJcs(materialized.project),
    planned_timeline_digest: digestJcs(materialized.timeline),
    planned_edit_brief_digest: digestJcs(materialized.editBrief),
    preview_path: preview.output_path,
    preview_sha256: preview.output_sha256,
    confirmation_token: randomUUID(),
    created_at: new Date().toISOString(),
  };
  await writeLocalArtifact(
    projectDirectory,
    "preview-confirmation.json",
    confirmation,
  );
  return { preview, confirmation };
}

export async function applyPreviewedManifest(
  projectDirectory: string,
  envelope: DirectorEnvelope<EditDecisionManifest>,
  confirmationToken: string,
): Promise<ApplyManifestResult> {
  const opened = await openCreatorCutProject(projectDirectory);
  const manifest = assertManifestBinding(opened, envelope);
  const confirmation = await readLocalArtifact<PreviewRecord>(
    projectDirectory,
    "preview-confirmation.json",
  );
  if (
    !confirmation ||
    confirmation.schema_version !== "creatorcut-preview-confirmation/1.0" ||
    confirmation.confirmation_token !== confirmationToken ||
    confirmation.project_id !== opened.project.project_id ||
    confirmation.base_revision !== opened.project.revision ||
    confirmation.manifest_digest !== digestJcs(envelope)
  ) {
    throw new Error(
      "CreatorCut apply requires the exact confirmed local preview token",
    );
  }
  if (
    !(await access(confirmation.preview_path)
      .then(() => true)
      .catch(() => false)) ||
    (await sha256File(confirmation.preview_path)) !==
      confirmation.preview_sha256
  ) {
    throw new Error("CreatorCut preview file is missing or changed");
  }
  const timeline = applyEditOperations({
    project: opened.project,
    timeline: opened.timeline,
    operations: manifest.operations,
  });
  const materialized = await materializeFinishing(
    opened,
    timeline,
    manifest.finishing,
    confirmation.manifest_digest,
  );
  if (
    digestJcs(materialized.project) !== confirmation.planned_project_digest ||
    digestJcs(materialized.timeline) !== confirmation.planned_timeline_digest ||
    digestJcs(materialized.editBrief) !== confirmation.planned_edit_brief_digest
  ) {
    throw new Error("CreatorCut preview and apply finishing digests differ");
  }
  return {
    opened: await commitLocalRevision(projectDirectory, {
      baseRevision: opened.project.revision,
      nextProject: materialized.project,
      nextTimeline: materialized.timeline,
      nextEditBrief: materialized.editBrief,
      operationIds: [
        ...manifest.operations.map((operation) => operation.operation_id),
        ...(manifest.finishing ? [`finishing:${manifest.manifest_id}`] : []),
      ],
      manifestDigest: confirmation.manifest_digest,
    }),
    manifest_digest: confirmation.manifest_digest,
  };
}
