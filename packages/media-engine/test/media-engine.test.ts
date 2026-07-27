import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DirectorEnvelope,
  EditDecisionManifest,
  EditOperation,
} from "@agentmesh/creatorcut-protocol";
import {
  createCreatorCutProject,
  openCreatorCutProject,
} from "@agentmesh/creatorcut-runtime";
import { describe, expect, it } from "vitest";

import {
  applyEditOperations,
  applyPreviewedManifest,
  importMedia,
  previewSignedManifest,
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
  });
});
