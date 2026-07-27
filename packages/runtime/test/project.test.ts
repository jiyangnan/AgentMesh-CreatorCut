import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  approveDirectorContext,
  buildDirectorContext,
  commitLocalRevision,
  createCreatorCutProject,
  inspectDirectorContext,
  openCreatorCutProject,
  redoLocalRevision,
  requireDirectorConsent,
  undoLocalRevision,
} from "../src/index.js";

async function fixtureProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "creatorcut-public-runtime-"));
  const state = join(root, ".creatorcut");
  await mkdir(state);
  const write = (name: string, value: unknown) =>
    writeFile(join(state, name), JSON.stringify(value), "utf8");
  await write("project.json", {
    schema_version: "1.0-alpha",
    project_id: "project-public-1",
    name: "Public fixture",
    revision: 2,
    assets: [
      {
        asset_id: "asset-1",
        kind: "video",
        relative_path: "assets/source.mp4",
        sha256: "a".repeat(64),
        duration_us: 5_000_000,
        width: 1920,
        height: 1080,
        has_video: true,
        has_audio: true,
      },
    ],
  });
  await write("timeline.json", {
    schema_version: "1.0-alpha",
    timeline_id: "timeline-1",
    project_id: "project-public-1",
    revision: 2,
    duration_us: 5_000_000,
    canvas: { width: 1920, height: 1080 },
    tracks: [
      {
        track_id: "video-1",
        kind: "video",
        clips: [
          {
            clip_id: "clip-1",
            asset_id: "asset-1",
            source_start_us: 0,
            source_end_us: 5_000_000,
            timeline_start_us: 0,
            timeline_end_us: 5_000_000,
          },
        ],
      },
    ],
  });
  await write("transcript.json", {
    schema_version: "1.0-alpha",
    transcript_id: "transcript-1",
    project_id: "project-public-1",
    revision: 2,
    language_mode: "mixed",
    segments: [
      {
        segment_id: "segment-1",
        source_asset_id: "asset-1",
        start_us: 0,
        end_us: 2_000_000,
        display_text: "你好 CreatorCut",
        tokens: [
          {
            token_id: "token-1",
            text: "你好",
            start_us: 0,
            end_us: 900_000,
            language: "zh",
            confidence: 0.98,
          },
          {
            token_id: "token-2",
            text: "CreatorCut",
            start_us: 1_000_000,
            end_us: 2_000_000,
            language: "en",
            confidence: 0.99,
          },
        ],
      },
    ],
  });
  await write("edit-brief.json", {
    schema_version: "1.0-alpha",
    brief_id: "brief-1",
    project_id: "project-public-1",
    base_revision: 2,
    audio_mode: "original",
    caption_style_id: "caption_clean",
    approved: true,
  });
  return root;
}

describe("public CreatorCut runtime", () => {
  it("creates, commits, undoes, and redoes monotonic local revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "creatorcut-public-store-"));
    const projectDirectory = join(root, "project.creatorcut");
    await createCreatorCutProject(projectDirectory, {
      project: {
        schema_version: "1.0",
        project_id: "project-store-1",
        name: "Store fixture",
        revision: 0,
        assets: [
          {
            asset_id: "asset-1",
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
        timeline_id: "timeline-store-1",
        project_id: "project-store-1",
        revision: 0,
        duration_us: 5_000_000,
        canvas: { width: 1920, height: 1080 },
        tracks: [
          {
            track_id: "track-video",
            kind: "video",
            clips: [
              {
                clip_id: "clip-1",
                asset_id: "asset-1",
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
    const committed = await commitLocalRevision(projectDirectory, {
      baseRevision: 0,
      nextTimeline: {
        ...(await openCreatorCutProject(projectDirectory)).timeline,
        canvas: { width: 1080, height: 1920 },
      },
      operationIds: ["operation-canvas"],
      manifestDigest: `sha256:${"b".repeat(64)}`,
    });
    expect(committed.project.revision).toBe(1);
    expect(committed.timeline.canvas.width).toBe(1080);

    const undone = await undoLocalRevision(projectDirectory);
    expect(undone.project.revision).toBe(2);
    expect(undone.timeline.canvas.width).toBe(1920);

    const redone = await redoLocalRevision(projectDirectory);
    expect(redone.project.revision).toBe(3);
    expect(redone.timeline.canvas.width).toBe(1080);
  });

  it("builds a path-free mixed-language DirectorContext", async () => {
    const opened = await openCreatorCutProject(await fixtureProject());
    const context = buildDirectorContext(opened, {
      clientVersion: "0.1.0",
      hostType: "text",
    });
    const inspection = inspectDirectorContext(context);

    expect(context.transcript.language_mode).toBe("mixed");
    expect(context.transcript.token_count).toBe(2);
    expect(inspection.uploads_original_media).toBe(false);
    expect(JSON.stringify(context)).not.toContain(opened.directory);
    expect(JSON.stringify(context)).not.toContain("assets/source.mp4");
  });

  it("binds consent to the exact revision and planning input", async () => {
    const opened = await openCreatorCutProject(await fixtureProject());
    const context = buildDirectorContext(opened);
    const record = await approveDirectorContext(opened, context);
    expect(await requireDirectorConsent(opened, context)).toEqual(record);
    const mode = (
      await stat(join(opened.creatorcutDirectory, "director-consent.json"))
    ).mode;
    expect(mode & 0o077).toBe(0);
    const persisted = await readFile(
      join(opened.creatorcutDirectory, "director-consent.json"),
      "utf8",
    );
    expect(persisted).not.toContain("你好 CreatorCut");
  });

  it("rejects a consent record after context changes", async () => {
    const opened = await openCreatorCutProject(await fixtureProject());
    const original = buildDirectorContext(opened);
    await approveDirectorContext(opened, original);
    const changed = structuredClone(original);
    changed.client_version = "0.1.1";
    changed.capabilities.client_version = "0.1.1";
    const { digestJcs } = await import("@agentmesh/creatorcut-protocol");
    changed.capabilities_digest = digestJcs(changed.capabilities);
    await expect(requireDirectorConsent(opened, changed)).rejects.toThrow(
      /not approved/u,
    );
  });
});
