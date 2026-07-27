import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DirectorEnvelope,
  EditDecisionManifest,
  EditOperation,
} from "@agentmesh/creatorcut-protocol";
import {
  commitLocalRevision,
  createCreatorCutProject,
  openCreatorCutProject,
  writeLocalArtifact,
} from "@agentmesh/creatorcut-runtime";
import { describe, expect, it } from "vitest";

import {
  applyEditOperations,
  applyPreviewedManifest,
  importMedia,
  previewSignedManifest,
  resumeExportTask,
  startExportTask,
  type ProcessRunner,
} from "../src/index.js";

const probeJson = JSON.stringify({
  format: { duration: "5.0" },
  streams: [
    {
      codec_type: "video",
      codec_name: "h264",
      width: 1920,
      height: 1080,
      avg_frame_rate: "30/1",
    },
    {
      codec_type: "audio",
      codec_name: "aac",
      sample_rate: "48000",
      channels: 2,
    },
  ],
});

const mediaRunner: ProcessRunner = async (command, args) => {
  if (command.includes("ffprobe")) {
    return { exitCode: 0, stdout: probeJson, stderr: "" };
  }
  const output = args.at(-1);
  if (output && output !== "-") await writeFile(output, "rendered-media");
  return { exitCode: 0, stdout: "", stderr: "" };
};

function canvasOperation(baseRevision = 0): EditOperation {
  return {
    schema_version: "1.0",
    operation_id: "operation_canvas",
    operation_type: "set_canvas",
    base_revision: baseRevision,
    preconditions: [
      { kind: "revision_equals", expected_revision: baseRevision },
    ],
    parameters: { width: 1080, height: 1920 },
    inverse: { kind: "restore_snapshot", revision: baseRevision },
  };
}

function removeRangeOperation(
  overrides: Partial<EditOperation> = {},
): EditOperation {
  return {
    schema_version: "1.0",
    operation_id: "operation-remove-range",
    operation_type: "remove_range",
    base_revision: 0,
    preconditions: [
      { kind: "revision_equals", expected_revision: 0 },
      {
        kind: "clip_mapping_equals",
        clip_ref: "clip-source",
        source_asset_ref: "asset-source",
        source_start_us: 0,
        source_end_us: 5_000_000,
      },
      {
        kind: "range_within",
        track_ref: "track-video",
        start_us: 1_000_000,
        end_us: 2_000_000,
      },
    ],
    parameters: {
      track_ref: "track-video",
      clip_ref: "clip-source",
      timeline_start_us: 1_000_000,
      timeline_end_us: 2_000_000,
      ripple_all: true,
      source_asset_ref: "asset-source",
      source_start_us: 1_000_000,
      source_end_us: 2_000_000,
      review_plan_ref: "review-plan-1",
      suggestion_ref: "suggestion-1",
      segment_refs: ["segment-1"],
      token_refs: ["token-1"],
    },
    inverse: { kind: "restore_snapshot", revision: 0 },
    ...overrides,
  };
}

async function projectFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "creatorcut-media-test-"));
  const directory = join(root, "project.creatorcut");
  await createCreatorCutProject(directory, {
    project: {
      schema_version: "1.0",
      project_id: "project-media-1",
      name: "Media fixture",
      revision: 0,
      assets: [
        {
          asset_id: "asset-source",
          kind: "video",
          relative_path: "media/source.mp4",
          sha256: "a".repeat(64),
          duration_us: 5_000_000,
          width: 1920,
          height: 1080,
          has_video: true,
          has_audio: true,
        },
      ],
    },
    timeline: {
      schema_version: "1.0",
      timeline_id: "timeline-media-1",
      project_id: "project-media-1",
      revision: 0,
      duration_us: 5_000_000,
      canvas: { width: 1920, height: 1080 },
      tracks: [
        {
          track_id: "track-video",
          kind: "video",
          clips: [
            {
              clip_id: "clip-source",
              asset_id: "asset-source",
              source_start_us: 0,
              source_end_us: 5_000_000,
              timeline_start_us: 0,
              timeline_end_us: 5_000_000,
            },
          ],
        },
      ],
    },
  });
  await writeFile(join(directory, "media", "source.mp4"), "source-media");
  return directory;
}

function envelope(): DirectorEnvelope<EditDecisionManifest> {
  return {
    envelope_version: "1.0",
    artifact_type: "edit_manifest",
    artifact_id: "artifact-manifest",
    session_id: "session-1",
    quote_id: "quote-1",
    generation_id: "generation-1",
    account_ref: "account-1",
    project_id: "project-media-1",
    sequence: 3,
    previous_envelope_digest: `sha256:${"1".repeat(64)}`,
    protocol_version: "1.0",
    policy_version: "policy-1",
    base_revision: 0,
    planning_input_digest: `sha256:${"2".repeat(64)}`,
    transcript_digest: `sha256:${"3".repeat(64)}`,
    timeline_digest: `sha256:${"4".repeat(64)}`,
    edit_brief_digest: `sha256:${"5".repeat(64)}`,
    answer_chain_digest: `sha256:${"6".repeat(64)}`,
    capabilities_digest: `sha256:${"7".repeat(64)}`,
    issued_at: "2026-07-27T00:00:00.000Z",
    payload: {
      schema_version: "1.0",
      manifest_id: "manifest-1",
      review_plan_digest: `sha256:${"8".repeat(64)}`,
      final_decisions_digest: `sha256:${"9".repeat(64)}`,
      billing_receipt_ref: "billing-1",
      required_operation_types: ["set_canvas"],
      operations: [canvasOperation()],
      summary: "Portrait preview",
    },
    signature: {
      algorithm: "Ed25519",
      key_id: "director-1",
      value: Buffer.alloc(64).toString("base64"),
    },
  };
}

describe("public local media execution", () => {
  it("imports a local source, verifies its copy, and creates a proxy project", async () => {
    const root = await mkdtemp(join(tmpdir(), "creatorcut-import-test-"));
    const source = join(root, "source.mov");
    const destination = join(root, "source.creatorcut");
    await writeFile(source, "source-media");
    const result = await importMedia({
      sourcePath: source,
      projectDirectory: destination,
      runner: mediaRunner,
    });
    expect(result.probe.has_video).toBe(true);
    expect((await openCreatorCutProject(destination)).project.revision).toBe(0);
    expect(
      await readFile(join(destination, "proxies", "source-proxy.mp4"), "utf8"),
    ).toBe("rendered-media");
  });

  it("applies only revision-bound protocol operations", async () => {
    const opened = await openCreatorCutProject(await projectFixture());
    const timeline = applyEditOperations({
      project: opened.project,
      timeline: opened.timeline,
      operations: [canvasOperation()],
    });
    expect(timeline.canvas).toMatchObject({ width: 1080, height: 1920 });
    expect(() =>
      applyEditOperations({
        project: opened.project,
        timeline: opened.timeline,
        operations: [canvasOperation(1)],
      }),
    ).toThrow(/revision/u);
  });

  it("resolves a Server-style remove_range only against the immutable base refs", async () => {
    const opened = await openCreatorCutProject(await projectFixture());
    const timeline = applyEditOperations({
      project: opened.project,
      timeline: opened.timeline,
      operations: [removeRangeOperation()],
    });
    expect(timeline.duration_us).toBe(4_000_000);
    expect(timeline.tracks[0]?.clips).toHaveLength(2);
    expect(timeline.tracks[0]?.clips.map((clip) => clip.clip_id)).toEqual([
      expect.stringMatching(/^clip-source:left:/u),
      expect.stringMatching(/^clip-source:right:/u),
    ]);
  });

  it("resolves explicit output refs deterministically without adding implicit refs", async () => {
    const opened = await openCreatorCutProject(await projectFixture());
    const operations: EditOperation[] = [
      {
        schema_version: "1.0",
        operation_id: "operation-split-output",
        operation_type: "split",
        base_revision: 0,
        preconditions: [{ kind: "clip_exists", clip_ref: "clip-source" }],
        parameters: {
          clip_ref: "clip-source",
          at_timeline_us: 2_500_000,
          left_clip_ref: "clip-left-output",
          right_clip_ref: "clip-right-output",
        },
        inverse: { kind: "restore_snapshot", revision: 0 },
      },
      {
        schema_version: "1.0",
        operation_id: "operation-trim-output",
        operation_type: "trim",
        base_revision: 0,
        preconditions: [],
        parameters: {
          clip_ref: "clip-right-output",
          source_start_us: 3_000_000,
          source_end_us: 4_000_000,
        },
        inverse: { kind: "restore_snapshot", revision: 0 },
      },
    ];
    const first = applyEditOperations({
      project: opened.project,
      timeline: opened.timeline,
      operations,
    });
    const second = applyEditOperations({
      project: opened.project,
      timeline: opened.timeline,
      operations,
    });
    expect(first).toEqual(second);
    expect(first.tracks[0]?.clips).toEqual([
      expect.objectContaining({
        clip_id: expect.stringMatching(/^clip:wire:/u),
        source_start_us: 0,
        source_end_us: 2_500_000,
      }),
      expect.objectContaining({
        clip_id: expect.stringMatching(/^clip:wire:/u),
        source_start_us: 3_000_000,
        source_end_us: 4_000_000,
      }),
    ]);
  });

  it("fails closed on unresolved, cross-type, output-precondition and stale refs", async () => {
    const opened = await openCreatorCutProject(await projectFixture());
    expect(() =>
      applyEditOperations({
        project: opened.project,
        timeline: opened.timeline,
        operations: [
          {
            ...canvasOperation(),
            operation_id: "operation-unresolved",
            operation_type: "trim",
            parameters: {
              clip_ref: "clip-missing",
              source_start_us: 0,
              source_end_us: 1_000_000,
            },
          },
        ],
      }),
    ).toThrow(/unresolved clip_ref/u);

    const ambiguousProject = structuredClone(opened.project);
    const ambiguousAsset = ambiguousProject.assets[0];
    if (!ambiguousAsset) throw new Error("Fixture asset missing");
    ambiguousAsset.asset_id = "track-video";
    expect(() =>
      applyEditOperations({
        project: ambiguousProject,
        timeline: opened.timeline,
        operations: [canvasOperation()],
      }),
    ).toThrow(/reused across asset and track/u);

    expect(() =>
      applyEditOperations({
        project: opened.project,
        timeline: opened.timeline,
        operations: [
          {
            schema_version: "1.0",
            operation_id: "operation-split-precondition",
            operation_type: "split",
            base_revision: 0,
            preconditions: [],
            parameters: {
              clip_ref: "clip-source",
              at_timeline_us: 2_500_000,
              left_clip_ref: "clip-left-new",
              right_clip_ref: "clip-right-new",
            },
            inverse: { kind: "restore_snapshot", revision: 0 },
          },
          {
            schema_version: "1.0",
            operation_id: "operation-output-precondition",
            operation_type: "trim",
            base_revision: 0,
            preconditions: [
              { kind: "clip_exists", clip_ref: "clip-right-new" },
            ],
            parameters: {
              clip_ref: "clip-right-new",
              source_start_us: 3_000_000,
              source_end_us: 4_000_000,
            },
            inverse: { kind: "restore_snapshot", revision: 0 },
          },
        ],
      }),
    ).toThrow(/unresolved base clip_ref/u);

    expect(() =>
      applyEditOperations({
        project: opened.project,
        timeline: opened.timeline,
        operations: [
          removeRangeOperation({
            inverse: { kind: "restore_snapshot", revision: 1 },
          }),
        ],
      }),
    ).toThrow(/operation revision/u);
  });

  it("requires an unchanged rendered preview before committing a Manifest", async () => {
    const directory = await projectFixture();
    const preview = await previewSignedManifest(
      directory,
      envelope(),
      undefined,
      { runner: mediaRunner },
    );
    expect((await openCreatorCutProject(directory)).project.revision).toBe(0);
    await expect(
      applyPreviewedManifest(directory, envelope(), "wrong-token"),
    ).rejects.toThrow(/exact confirmed/u);
    const applied = await applyPreviewedManifest(
      directory,
      envelope(),
      preview.confirmation.confirmation_token,
    );
    expect(applied.opened.project.revision).toBe(1);
    expect(applied.opened.timeline.canvas.width).toBe(1080);
    await expect(
      applyPreviewedManifest(
        directory,
        envelope(),
        preview.confirmation.confirmation_token,
      ),
    ).rejects.toThrow(/stale or belongs to another project/u);
    expect((await openCreatorCutProject(directory)).project.revision).toBe(1);
  });

  it("rejects changed preview bytes, Manifest bindings, and project revisions", async () => {
    const changedPreviewDirectory = await projectFixture();
    const changedPreview = await previewSignedManifest(
      changedPreviewDirectory,
      envelope(),
      undefined,
      { runner: mediaRunner },
    );
    await writeFile(changedPreview.preview.output_path, "tampered-preview");
    await expect(
      applyPreviewedManifest(
        changedPreviewDirectory,
        envelope(),
        changedPreview.confirmation.confirmation_token,
      ),
    ).rejects.toThrow(/preview file is missing or changed/u);

    const changedManifestDirectory = await projectFixture();
    const changedManifestPreview = await previewSignedManifest(
      changedManifestDirectory,
      envelope(),
      undefined,
      { runner: mediaRunner },
    );
    const changedManifest = envelope();
    changedManifest.payload.operations[0]!.parameters.width = 720;
    await expect(
      applyPreviewedManifest(
        changedManifestDirectory,
        changedManifest,
        changedManifestPreview.confirmation.confirmation_token,
      ),
    ).rejects.toThrow(/exact confirmed local preview token/u);

    const changedRevisionDirectory = await projectFixture();
    const changedRevisionPreview = await previewSignedManifest(
      changedRevisionDirectory,
      envelope(),
      undefined,
      { runner: mediaRunner },
    );
    const opened = await openCreatorCutProject(changedRevisionDirectory);
    await commitLocalRevision(changedRevisionDirectory, {
      baseRevision: opened.project.revision,
      nextTimeline: opened.timeline,
      operationIds: ["operation-unrelated"],
    });
    await expect(
      applyPreviewedManifest(
        changedRevisionDirectory,
        envelope(),
        changedRevisionPreview.confirmation.confirmation_token,
      ),
    ).rejects.toThrow(/stale or belongs to another project/u);
  });

  it("never overwrites an existing export without explicit confirmation", async () => {
    const directory = await projectFixture();
    const output = join(directory, "exports", "existing.mp4");
    await mkdir(join(directory, "exports"), { recursive: true });
    await writeFile(output, "existing-output");

    const rejected = await startExportTask(directory, output, {
      runner: mediaRunner,
    });
    expect(rejected).toMatchObject({
      state: "failed",
      error: {
        code: "export_failed",
        message: expect.stringMatching(/will not overwrite/u),
      },
    });
    expect(await readFile(output, "utf8")).toBe("existing-output");

    const confirmed = await startExportTask(directory, output, {
      overwrite: true,
      runner: mediaRunner,
    });
    expect(confirmed.state).toBe("completed");
    expect(await readFile(output, "utf8")).toBe("rendered-media");

    const assetPath = join(directory, "media", "source.mp4");
    const assetRejected = await startExportTask(directory, assetPath, {
      overwrite: true,
      runner: mediaRunner,
    });
    expect(assetRejected).toMatchObject({
      state: "failed",
      error: {
        message: expect.stringMatching(/never overwrite a project asset/u),
      },
    });
    expect(await readFile(assetPath, "utf8")).toBe("source-media");
  });

  it("resumes an interrupted export with the same task identity", async () => {
    const directory = await projectFixture();
    const output = join(directory, "exports", "resume.mp4");
    const failingRunner: ProcessRunner = async (command) => {
      if (command.includes("ffprobe")) {
        return { exitCode: 0, stdout: probeJson, stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "interrupted" };
    };
    const interrupted = await startExportTask(directory, output, {
      runner: failingRunner,
    });
    expect(interrupted.state).toBe("failed");

    const resumed = await resumeExportTask(directory, {
      runner: mediaRunner,
    });
    expect(resumed).toMatchObject({
      task_id: interrupted.task_id,
      state: "completed",
      output_path: output,
      result: { output_path: output },
    });
    expect(await readFile(output, "utf8")).toBe("rendered-media");
  });

  it("finalizes a previously materialized export without rerendering", async () => {
    const directory = await projectFixture();
    const output = join(directory, "exports", "materialized.mp4");
    const completed = await startExportTask(directory, output, {
      runner: mediaRunner,
    });
    expect(completed.state).toBe("completed");
    await writeLocalArtifact(directory, "tasks/export.json", {
      ...completed,
      state: "finalizing",
      progress_millis: 900,
    });
    let processCalls = 0;
    const forbiddenRunner: ProcessRunner = async () => {
      processCalls += 1;
      throw new Error("export must not rerender");
    };

    const recovered = await resumeExportTask(directory, {
      runner: forbiddenRunner,
    });
    expect(recovered).toMatchObject({
      task_id: completed.task_id,
      state: "completed",
      output_sha256: completed.output_sha256,
      output_path: output,
    });
    expect(processCalls).toBe(0);
    expect(await readFile(output, "utf8")).toBe("rendered-media");
  });

  it("rejects a tampered recovery locator even when a project asset has the expected export bytes", async () => {
    const directory = await projectFixture();
    const output = join(directory, "exports", "safe.mp4");
    const completed = await startExportTask(directory, output, {
      runner: mediaRunner,
    });
    const assetPath = join(directory, "media", "source.mp4");
    await writeFile(assetPath, await readFile(output));
    await writeLocalArtifact(directory, "tasks/export.json", {
      ...completed,
      state: "finalizing",
      progress_millis: 900,
    });
    await writeLocalArtifact(directory, "tasks/export-locator.json", {
      schema_version: "creatorcut-export-locator/1.0",
      output_path: assetPath,
      ffmpeg_path: "ffmpeg",
      ffprobe_path: "ffprobe",
      overwrite: true,
    });

    await expect(resumeExportTask(directory)).resolves.toMatchObject({
      state: "failed",
      error: {
        message: expect.stringMatching(/never overwrite a project asset/u),
      },
    });
    expect(await readFile(assetPath, "utf8")).toBe("rendered-media");
  });
});
