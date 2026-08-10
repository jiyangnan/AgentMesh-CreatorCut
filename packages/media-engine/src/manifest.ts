import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  assertPublicProtocol,
  digestJcs,
  type DirectorEnvelope,
  type EditDecisionManifest,
} from "@agentmesh/creatorcut-protocol";
import {
  assertPrivateWorkDirectory,
  compareAndSwapLocalArtifact,
  commitLocalRevision,
  finalizePrivateWorkFile,
  openCreatorCutProject,
  preparePrivateWorkDirectory,
  privateWorkPath,
  readLocalArtifact,
  releasePrivateWorkDirectory,
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
  options: MediaToolOptions = {},
): Promise<{ preview: RenderTimelineResult; confirmation: PreviewRecord }> {
  const unknownOption = Object.keys(options).find(
    (key) => !["ffmpegPath", "ffprobePath", "runner", "signal"].includes(key),
  );
  if (unknownOption) {
    throw new TypeError(
      `CreatorCut preview does not accept caller-controlled option: ${unknownOption}`,
    );
  }
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
  const previewId = randomUUID();
  const previewDirectory = resolve(opened.directory, "previews");
  await mkdir(previewDirectory, { recursive: true, mode: 0o700 });
  const workLease = await preparePrivateWorkDirectory(opened.directory, [
    "previews",
  ]);
  const previewDirectoryInfo = await lstat(previewDirectory, { bigint: true });
  if (
    previewDirectoryInfo.isSymbolicLink() ||
    !previewDirectoryInfo.isDirectory() ||
    (await realpath(previewDirectory)) !== previewDirectory
  ) {
    throw new Error(
      "CreatorCut preview directory is not a trusted local directory",
    );
  }
  const previewPath = join(previewDirectory, `preview-${previewId}.mp4`);
  const temporaryPreviewPath = privateWorkPath(
    workLease,
    `preview-${previewId}.partial.mp4`,
  );
  try {
    const rendered = await renderTimeline({
      ...options,
      projectDirectory: opened.directory,
      project: materialized.project,
      timeline: materialized.timeline,
      outputPath: temporaryPreviewPath,
      quality: "preview",
      overwrite: true,
    });
    await finalizePrivateWorkFile(workLease, temporaryPreviewPath);
    const preview: RenderTimelineResult = {
      ...rendered,
      output_path: previewPath,
    };
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
    const previousConfirmation = await readLocalArtifact<PreviewRecord>(
      projectDirectory,
      "preview-confirmation.json",
    );
    const completed = await compareAndSwapLocalArtifact<
      PreviewRecord,
      {
        preview: RenderTimelineResult;
        confirmation: PreviewRecord;
      }
    >(
      projectDirectory,
      "preview-confirmation.json",
      {
        projectId: opened.project.project_id,
        revision: opened.project.revision,
        authorityGeneration: opened.authorityGeneration,
        artifactDigest: digestJcs(previousConfirmation),
      },
      async () => {
        await assertPrivateWorkDirectory(workLease);
        await finalizePrivateWorkFile(workLease, temporaryPreviewPath);
        const currentDirectoryInfo = await lstat(previewDirectory, {
          bigint: true,
        });
        if (
          currentDirectoryInfo.isSymbolicLink() ||
          !currentDirectoryInfo.isDirectory() ||
          currentDirectoryInfo.dev !== previewDirectoryInfo.dev ||
          currentDirectoryInfo.ino !== previewDirectoryInfo.ino ||
          (await realpath(previewDirectory)) !== previewDirectory
        ) {
          throw new Error(
            "CreatorCut preview directory changed before final publish",
          );
        }
        if (
          await access(previewPath)
            .then(() => true)
            .catch(() => false)
        ) {
          throw new Error("CreatorCut managed preview path already exists");
        }
        await rename(temporaryPreviewPath, previewPath);
        if ((await sha256File(previewPath)) !== preview.output_sha256) {
          await rm(previewPath, { force: true });
          throw new Error("CreatorCut preview publish digest mismatch");
        }
        return {
          nextArtifact: confirmation,
          value: { preview, confirmation },
        };
      },
    );
    return completed.value;
  } finally {
    await releasePrivateWorkDirectory(workLease);
  }
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
