import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  DirectorEnvelope,
  EditDecisionManifest,
  EditOperation,
} from "@agentmesh/creatorcut-protocol";
import {
  commitLocalRevision,
  createCreatorCutProject,
  openCreatorCutProject,
  readLocalArtifact,
  writeLocalArtifact,
} from "@agentmesh/creatorcut-runtime";
import { describe, expect, it } from "vitest";
import { adoptLegacyPublicProject } from "../../runtime/src/storage-authority.js";

import {
  applyEditOperations,
  applyPreviewedManifest,
  cancelExportTask,
  importMedia,
  previewSignedManifest,
  readExportTask,
  renderTimeline,
  resumeExportTask,
  runExportTask,
  startExportTask,
  synthesizeLocalMusicBedWav,
  type ProcessRunner,
  type MediaToolOptions,
  type ExportLocator,
  type ExportTask,
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
    transcript: {
      schema_version: "1.0",
      transcript_id: "transcript-media-1",
      project_id: "project-media-1",
      revision: 0,
      language_mode: "mixed",
      segments: [
        {
          segment_id: "segment-media-1",
          source_asset_id: "asset-source",
          start_us: 0,
          end_us: 4_000_000,
          display_text: "你好 CreatorCut export",
          tokens: [
            {
              token_id: "token-media-1",
              text: "你好",
              start_us: 0,
              end_us: 800_000,
              language: "zh",
              confidence: 0.99,
            },
            {
              token_id: "token-media-2",
              text: "CreatorCut",
              start_us: 900_000,
              end_us: 2_000_000,
              language: "en",
              confidence: 0.99,
            },
            {
              token_id: "token-media-3",
              text: "export",
              start_us: 2_200_000,
              end_us: 4_000_000,
              language: "en",
              confidence: 0.98,
            },
          ],
        },
      ],
    },
  });
  await writeFile(join(directory, "media", "source.mp4"), "source-media");
  return directory;
}

async function activateVisualComposition(directory: string): Promise<void> {
  const state = join(directory, ".creatorcut");
  const visual = {
    schema_version: "creatorcut-visual-composition/1.0",
    composition_id: "visual-media-active",
    project_id: "project-media-1",
    timeline_id: "timeline-media-1",
    rough_cut_revision: 0,
    project_revision: 0,
    state: "active",
    visual_catalog_version: "creatorcut-visual-catalog/1.0",
    visual_catalog_digest: `sha256:${"b".repeat(64)}`,
    visual_events: [],
    provenance: {
      fine_cut_chain_id: "fine-chain-media",
      answer_digest: `sha256:${"c".repeat(64)}`,
      origin: "local_rule",
    },
    created_at: "2026-08-09T00:00:00.000Z",
    updated_at: "2026-08-09T00:00:00.000Z",
  };
  const versionPath = join(state, "versions", "0.json");
  const version = JSON.parse(await readFile(versionPath, "utf8"));
  version.visual_composition = visual;
  await Promise.all([
    rm(join(state, "storage-authority.json")),
    rm(join(state, "storage-mutations.jsonl")),
    writeFile(versionPath, JSON.stringify(version)),
    writeFile(join(state, "visual-composition.json"), JSON.stringify(visual)),
  ]);
  await adoptLegacyPublicProject(directory, { confirmLocal: true });
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
      finishing: {
        caption_style_id: "caption_none",
        lut_id: "lut_none",
        voice_mode: "original",
        background_music: { mode: "none" },
      },
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
    const preview = await previewSignedManifest(directory, envelope(), {
      runner: mediaRunner,
    });
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

  it("keeps preview output managed and refuses caller-controlled paths", async () => {
    const directory = await projectFixture();
    const protectedPaths = [
      join(directory, ".creatorcut", "project.json"),
      join(directory, "media", "source.mp4"),
      join(directory, "external-target.mp4"),
    ];
    for (const outputPath of protectedPaths) {
      const before = await access(outputPath)
        .then(() => readFile(outputPath))
        .catch(() => null);
      await expect(
        previewSignedManifest(directory, envelope(), {
          runner: mediaRunner,
          outputPath,
        } as MediaToolOptions & { outputPath: string }),
      ).rejects.toThrow(/does not accept caller-controlled option/u);
      const after = await access(outputPath)
        .then(() => readFile(outputPath))
        .catch(() => null);
      expect(after).toEqual(before);
    }
    expect(
      await readdir(join(directory, "previews")).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      ),
    ).toEqual([]);
    expect(
      await readLocalArtifact(directory, "preview-confirmation.json"),
    ).toBeNull();
  });

  it("does not publish a preview when revision or authority changes during render", async () => {
    const directory = await projectFixture();
    let changed = false;
    const delayedRunner: ProcessRunner = async (command, args) => {
      if (command.includes("ffprobe")) {
        return { exitCode: 0, stdout: probeJson, stderr: "" };
      }
      const output = args.at(-1)!;
      await writeFile(output, "rendered-media");
      if (!changed) {
        changed = true;
        const current = await openCreatorCutProject(directory);
        await commitLocalRevision(directory, {
          baseRevision: current.project.revision,
          nextTimeline: current.timeline,
          operationIds: ["concurrent-preview-edit"],
        });
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await expect(
      previewSignedManifest(directory, envelope(), { runner: delayedRunner }),
    ).rejects.toThrow(/compare-and-swap authority changed/u);
    expect((await openCreatorCutProject(directory)).project.revision).toBe(1);
    expect(await readdir(join(directory, "previews"))).toEqual([]);
    expect(
      await readLocalArtifact(directory, "preview-confirmation.json"),
    ).toBeNull();
  });

  for (const attack of ["root", "previews"] as const) {
    it(`rejects a ${attack} private preview symlink without writing outside`, async () => {
      const directory = await projectFixture();
      const outside = await mkdtemp(
        join(tmpdir(), "creatorcut-preview-private-outside-"),
      );
      const sentinel = join(outside, "sentinel.txt");
      const sentinelBytes = Buffer.from("outside-preview-must-remain");
      await writeFile(sentinel, sentinelBytes);
      const privateRoot = join(directory, ".creatorcut-work");
      if (attack === "root") {
        await symlink(outside, privateRoot);
      } else {
        await mkdir(privateRoot, { mode: 0o700 });
        await symlink(outside, join(privateRoot, "previews"));
      }
      const before = (await readdir(outside)).sort();

      await expect(
        previewSignedManifest(directory, envelope(), { runner: mediaRunner }),
      ).rejects.toThrow(/private work|symbolic link|trusted/u);
      expect((await readdir(outside)).sort()).toEqual(before);
      expect(await readFile(sentinel)).toEqual(sentinelBytes);
      expect(
        await readLocalArtifact(directory, "preview-confirmation.json"),
      ).toBeNull();
    });
  }

  it.runIf(platform() !== "win32")(
    "tightens private preview directories and rendered files",
    async () => {
      const directory = await projectFixture();
      const privateRoot = join(directory, ".creatorcut-work");
      const privatePreviews = join(privateRoot, "previews");
      await mkdir(privatePreviews, { recursive: true, mode: 0o755 });
      await chmod(privateRoot, 0o755);
      await chmod(privatePreviews, 0o755);

      const preview = await previewSignedManifest(directory, envelope(), {
        runner: mediaRunner,
      });
      expect((await stat(privateRoot)).mode & 0o777).toBe(0o700);
      expect((await stat(privatePreviews)).mode & 0o777).toBe(0o700);
      expect((await stat(preview.preview.output_path)).mode & 0o777).toBe(
        0o600,
      );
    },
  );

  it("materializes signed captions, original voice, and local upbeat music before apply", async () => {
    const directory = await projectFixture();
    const signed = envelope();
    signed.payload.finishing = {
      caption_style_id: "caption_clean",
      lut_id: "lut_none",
      voice_mode: "original",
      background_music: {
        mode: "local_template",
        category_id: "upbeat",
        template_id: "light_tech",
      },
    };
    const preview = await previewSignedManifest(directory, signed, {
      runner: mediaRunner,
    });
    expect(await realpath(dirname(preview.preview.output_path))).toBe(
      await realpath(join(directory, "previews")),
    );
    expect(preview.confirmation.planned_project_digest).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
    const applied = await applyPreviewedManifest(
      directory,
      signed,
      preview.confirmation.confirmation_token,
    );
    expect(applied.opened.timeline.captions?.length).toBeGreaterThan(0);
    expect(
      applied.opened.timeline.tracks.find((track) => track.kind === "music")
        ?.clips,
    ).toHaveLength(1);
    expect(
      applied.opened.timeline.tracks.some(
        (track) => track.kind === "voiceover",
      ),
    ).toBe(false);
    expect(applied.opened.editBrief).toMatchObject({
      audio_mode: "original",
      caption_style_id: "caption_clean",
      lut_id: "lut_none",
      background_music: {
        mode: "local_template",
        template_id: "light_tech",
      },
    });
    const music = applied.opened.project.assets.find((asset) =>
      asset.asset_id.includes("asset_music_light_tech"),
    );
    expect(music).toBeDefined();
    expect(music!.relative_path).toMatch(/^generated\//u);
    expect(music!.relative_path).not.toContain("\\");
    expect(music!.relative_path).not.toContain(".creatorcut");
    expect(
      await readFile(join(directory, music!.relative_path), "ascii"),
    ).toMatch(/^RIFF/u);
  });

  it("keeps the final mixed output on the approved safe limiter ceiling", async () => {
    const directory = await projectFixture();
    const signed = envelope();
    signed.payload.finishing = {
      caption_style_id: "caption_clean",
      lut_id: "lut_none",
      voice_mode: "original",
      background_music: {
        mode: "local_template",
        category_id: "upbeat",
        template_id: "bright_launch",
      },
    };
    let ffmpegArgs: string[] = [];
    const runner: ProcessRunner = async (command, args) => {
      if (command === "ffprobe") {
        return { exitCode: 0, stdout: probeJson, stderr: "" };
      }
      ffmpegArgs = args;
      await writeFile(args.at(-1)!, "rendered-media");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await previewSignedManifest(directory, signed, { runner });

    const filterIndex = ffmpegArgs.indexOf("-filter_complex");
    expect(filterIndex).toBeGreaterThanOrEqual(0);
    const filter = ffmpegArgs[filterIndex + 1]!;
    expect(filter).toContain(
      "amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.89:level=false,aresample=48000[aout]",
    );
    expect(filter.match(/alimiter=limit=0\.89:level=false/gu)).toHaveLength(2);
    expect(filter).not.toMatch(/alimiter=limit=0\.89(?!:level=false)/u);
    expect(filter).not.toContain("alimiter=limit=0.95");
  });

  it("keeps the two approved upbeat templates deterministic and distinct", () => {
    const light = synthesizeLocalMusicBedWav(2_000_000, "light_tech");
    const bright = synthesizeLocalMusicBedWav(2_000_000, "bright_launch");
    expect(light.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bright.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(
      light.equals(synthesizeLocalMusicBedWav(2_000_000, "light_tech")),
    ).toBe(true);
    expect(light.equals(bright)).toBe(false);
  });

  it("preserves the source HLG profile and pins deterministic scheduling", async () => {
    const directory = await projectFixture();
    const opened = await openCreatorCutProject(directory);
    const project = structuredClone(opened.project);
    project.assets[0]!.color_primaries = "bt2020";
    project.assets[0]!.color_transfer = "arib-std-b67";
    project.assets[0]!.color_space = "bt2020nc";
    let ffmpegArgs: string[] = [];
    const runner: ProcessRunner = async (command, args) => {
      if (command === "ffprobe") {
        return { exitCode: 0, stdout: probeJson, stderr: "" };
      }
      ffmpegArgs = args;
      await writeFile(args.at(-1)!, "rendered-media");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await renderTimeline({
      projectDirectory: directory,
      project,
      timeline: opened.timeline,
      outputPath: join(directory, "exports", "hdr-preview.mp4"),
      quality: "preview",
      overwrite: true,
      runner,
    });
    const command = ffmpegArgs.join(" ");
    expect(command).not.toContain("zscale=");
    expect(command).not.toContain("tonemap=");
    expect(command).not.toContain("setparams=");
    expect(command).not.toContain("-color_primaries bt709");
    expect(command).not.toContain("-color_range tv");
    expect(command).toContain("-c:v libx265");
    expect(command).toContain("-pix_fmt yuv420p10le");
    expect(command).toContain("-filter_threads 1");
    expect(command).toContain("-filter_complex_threads 1");
    expect(command).toContain("-threads 1 -i");
    expect(command).toContain(
      "-x265-params frame-threads=1:lookahead-threads=1",
    );
    expect(command).toContain("-tag:v hvc1");
    expect(command).toContain("-color_primaries bt2020");
    expect(command).toContain("-color_trc arib-std-b67");
    expect(command).toContain("-colorspace bt2020nc");
  });

  it("refuses mixed source color profiles instead of converting them", async () => {
    const directory = await projectFixture();
    const opened = await openCreatorCutProject(directory);
    const project = structuredClone(opened.project);
    project.assets[0]!.color_primaries = "bt2020";
    project.assets[0]!.color_transfer = "arib-std-b67";
    project.assets[0]!.color_space = "bt2020nc";
    project.assets.push({
      ...project.assets[0]!,
      asset_id: "asset-sdr",
      relative_path: "media/sdr.mp4",
      color_primaries: "bt709",
      color_transfer: "bt709",
      color_space: "bt709",
    });
    const timeline = structuredClone(opened.timeline);
    timeline.tracks[0]!.clips.push({
      ...timeline.tracks[0]!.clips[0]!,
      clip_id: "clip-sdr",
      asset_id: "asset-sdr",
    });
    await expect(
      renderTimeline({
        projectDirectory: directory,
        project,
        timeline,
        outputPath: join(directory, "exports", "mixed-preview.mp4"),
        quality: "preview",
        overwrite: true,
        runner: mediaRunner,
      }),
    ).rejects.toThrow(/will not automatically convert mixed source color/u);
  });

  it("rejects changed preview bytes, Manifest bindings, and project revisions", async () => {
    const changedPreviewDirectory = await projectFixture();
    const changedPreview = await previewSignedManifest(
      changedPreviewDirectory,
      envelope(),
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
  }, 15_000);

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
  }, 15_000);

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
  }, 15_000);

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
  }, 15_000);

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
  }, 15_000);

  it("blocks start, resume, and direct export without mutating task state when visual rendering is unsupported", async () => {
    const directory = await projectFixture();
    await activateVisualComposition(directory);
    const output = join(directory, "exports", "visual-blocked.mp4");
    const taskPath = join(directory, ".creatorcut", "tasks", "export.json");

    await expect(
      startExportTask(directory, output, { runner: mediaRunner }),
    ).rejects.toThrow(/cannot materialize the active visual composition/u);
    await expect(access(taskPath)).rejects.toMatchObject({ code: "ENOENT" });

    const task: ExportTask = {
      schema_version: "creatorcut-export-task/1.0",
      task_id: "export:visual-bypass",
      project_id: "project-media-1",
      base_revision: 0,
      state: "queued",
      progress_millis: 0,
      created_at: "2026-08-09T00:00:00.000Z",
      updated_at: "2026-08-09T00:00:00.000Z",
    };
    const locator: ExportLocator = {
      schema_version: "creatorcut-export-locator/1.0",
      output_path: output,
      ffmpeg_path: "ffmpeg",
      ffprobe_path: "ffprobe",
      overwrite: false,
    };
    await writeLocalArtifact(directory, "tasks/export.json", task);
    await writeLocalArtifact(directory, "tasks/export-locator.json", locator);
    const before = await readFile(taskPath);
    let processCalls = 0;
    const forbiddenRunner: ProcessRunner = async () => {
      processCalls += 1;
      throw new Error("renderer must not run");
    };

    await expect(
      resumeExportTask(directory, { runner: forbiddenRunner }),
    ).rejects.toThrow(/cannot materialize the active visual composition/u);
    expect(await readFile(taskPath)).toEqual(before);
    expect(processCalls).toBe(0);
    expect(
      await access(output)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);

    await expect(
      runExportTask(directory, task, locator, { runner: forbiddenRunner }),
    ).rejects.toThrow(/cannot materialize the active visual composition/u);
    expect(await readFile(taskPath)).toEqual(before);
    expect(processCalls).toBe(0);
  });

  it("rejects export output paths inside .creatorcut before creating a task", async () => {
    const directory = await projectFixture();
    const output = join(directory, ".creatorcut", "exports", "forbidden.mp4");
    await expect(startExportTask(directory, output)).rejects.toThrow(
      /cannot be inside \.creatorcut/u,
    );
    expect(await readLocalArtifact(directory, "tasks/export.json")).toBeNull();
    expect(
      await access(output)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });

  it("does not publish a final export when the project revision changes during rendering", async () => {
    const directory = await projectFixture();
    const output = join(directory, "exports", "revision-race.mp4");
    let releaseRender!: () => void;
    let notifyRenderStarted!: () => void;
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const renderStarted = new Promise<void>((resolve) => {
      notifyRenderStarted = resolve;
    });
    const delayedRunner: ProcessRunner = async (command, args) => {
      if (command.includes("ffprobe")) {
        return { exitCode: 0, stdout: probeJson, stderr: "" };
      }
      const partial = args.at(-1);
      if (partial && partial !== "-")
        await writeFile(partial, "rendered-media");
      notifyRenderStarted();
      await renderGate;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const exportPromise = startExportTask(directory, output, {
      runner: delayedRunner,
    });
    await renderStarted;
    const opened = await openCreatorCutProject(directory);
    await commitLocalRevision(directory, {
      baseRevision: opened.project.revision,
      nextTimeline: opened.timeline,
      operationIds: ["operation-during-export"],
    });
    releaseRender();

    const result = await exportPromise;
    expect(result.state).toBe("failed");
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await readdir(join(directory, "exports"))).some((name) =>
        name.includes(".partial.mp4"),
      ),
    ).toBe(true);
  }, 15_000);

  it("keeps cancellation authoritative at the final export gate", async () => {
    const directory = await projectFixture();
    const output = join(directory, "exports", "cancel-race.mp4");
    let releaseRender!: () => void;
    let notifyRenderStarted!: () => void;
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const renderStarted = new Promise<void>((resolve) => {
      notifyRenderStarted = resolve;
    });
    const delayedRunner: ProcessRunner = async (command, args) => {
      if (command.includes("ffprobe")) {
        return { exitCode: 0, stdout: probeJson, stderr: "" };
      }
      const partial = args.at(-1);
      if (partial && partial !== "-")
        await writeFile(partial, "rendered-media");
      notifyRenderStarted();
      await renderGate;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const exportPromise = startExportTask(directory, output, {
      runner: delayedRunner,
    });
    await renderStarted;
    const cancelled = await cancelExportTask(directory);
    expect(cancelled.state).toBe("cancelled");
    releaseRender();

    const result = await exportPromise;
    expect(result.state).toBe("cancelled");
    expect(await readExportTask(directory)).toMatchObject({
      task_id: cancelled.task_id,
      state: "cancelled",
    });
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("rejects a same-revision authority generation change before final publish", async () => {
    const directory = await projectFixture();
    const output = join(directory, "exports", "generation-race.mp4");
    let releaseRender!: () => void;
    let notifyRenderStarted!: () => void;
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const renderStarted = new Promise<void>((resolve) => {
      notifyRenderStarted = resolve;
    });
    const delayedRunner: ProcessRunner = async (command, args) => {
      if (command.includes("ffprobe")) {
        return { exitCode: 0, stdout: probeJson, stderr: "" };
      }
      const partial = args.at(-1);
      if (partial && partial !== "-")
        await writeFile(partial, "rendered-media");
      notifyRenderStarted();
      await renderGate;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const exportPromise = startExportTask(directory, output, {
      runner: delayedRunner,
    });
    await renderStarted;
    await writeLocalArtifact(directory, "tasks/import.json", {
      schema_version: "creatorcut-import-task/1.0",
      state: "completed",
      source_asset_id: "asset-generation-change",
      source_sha256: "a".repeat(64),
      proxy_relative_path: "proxies/generation-change.mp4",
      proxy_sha256: "b".repeat(64),
      completed_at: "2026-08-09T00:00:00.000Z",
    });
    releaseRender();

    const result = await exportPromise;
    expect(result).toMatchObject({
      state: "failed",
      error: { message: expect.stringMatching(/authority changed/u) },
    });
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("does not overwrite a replacement task that appears during rendering", async () => {
    const directory = await projectFixture();
    const output = join(directory, "exports", "task-replacement.mp4");
    let releaseRender!: () => void;
    let notifyRenderStarted!: () => void;
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const renderStarted = new Promise<void>((resolve) => {
      notifyRenderStarted = resolve;
    });
    const delayedRunner: ProcessRunner = async (command, args) => {
      if (command.includes("ffprobe")) {
        return { exitCode: 0, stdout: probeJson, stderr: "" };
      }
      const partial = args.at(-1);
      if (partial && partial !== "-")
        await writeFile(partial, "rendered-media");
      notifyRenderStarted();
      await renderGate;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const exportPromise = startExportTask(directory, output, {
      runner: delayedRunner,
    });
    await renderStarted;
    const replacement: ExportTask = {
      schema_version: "creatorcut-export-task/1.0",
      task_id: "export:replacement",
      project_id: "project-media-1",
      base_revision: 0,
      state: "queued",
      progress_millis: 0,
      created_at: "2026-08-09T00:00:00.000Z",
      updated_at: "2026-08-09T00:00:00.000Z",
    };
    await writeLocalArtifact(directory, "tasks/export.json", replacement);
    releaseRender();

    const result = await exportPromise;
    expect(result.state).toBe("failed");
    expect(await readExportTask(directory)).toEqual(replacement);
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);
});
