import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CloudDirectorAdapter } from "@agentmesh/creatorcut-director-client";
import { digestJcs } from "@agentmesh/creatorcut-protocol";
import { describe, expect, it } from "vitest";

import { CreatorCutMcpService } from "../src/index.js";

async function projectFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "creatorcut-mcp-"));
  const state = join(root, ".creatorcut");
  await mkdir(state);
  const write = (name: string, value: unknown) =>
    writeFile(join(state, name), JSON.stringify(value), "utf8");
  await write("project.json", {
    schema_version: "1.0-alpha",
    project_id: "project-mcp-1",
    name: "MCP fixture",
    revision: 4,
    assets: [
      {
        asset_id: "asset-1",
        kind: "video",
        relative_path: "source.mov",
        sha256: "c".repeat(64),
        duration_us: 1_000_000,
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
    project_id: "project-mcp-1",
    revision: 4,
    duration_us: 1_000_000,
    canvas: { width: 1920, height: 1080 },
    tracks: [
      {
        track_id: "video",
        kind: "video",
        clips: [
          {
            clip_id: "clip",
            asset_id: "asset-1",
            source_start_us: 0,
            source_end_us: 1_000_000,
            timeline_start_us: 0,
            timeline_end_us: 1_000_000,
          },
        ],
      },
    ],
  });
  await write("transcript.json", {
    schema_version: "1.0-alpha",
    transcript_id: "transcript-1",
    project_id: "project-mcp-1",
    revision: 4,
    language_mode: "en",
    segments: [
      {
        segment_id: "segment-1",
        source_asset_id: "asset-1",
        start_us: 0,
        end_us: 1_000_000,
        display_text: "Hello",
        tokens: [
          {
            token_id: "token-1",
            text: "Hello",
            start_us: 0,
            end_us: 1_000_000,
            language: "en",
            confidence: 1,
          },
        ],
      },
    ],
  });
  await write("edit-brief.json", {
    schema_version: "1.0-alpha",
    brief_id: "brief-1",
    project_id: "project-mcp-1",
    base_revision: 4,
    audio_mode: "original",
    caption_style_id: "caption_clean",
    approved: true,
  });
  return root;
}

describe("CreatorCut public MCP service", () => {
  it("reads project facts and exact context without a Director connection", async () => {
    const project = await projectFixture();
    const service = new CreatorCutMcpService(project, async () => {
      throw new Error("Director should not be called");
    });
    await expect(service.projectStatus()).resolves.toMatchObject({
      project_id: "project-mcp-1",
      revision: 4,
      language_mode: "en",
    });
    const context = await service.inspectContext();
    expect(JSON.stringify(context)).not.toContain(project);
    expect(JSON.stringify(context)).toContain("Hello");
  });

  it("reports distinct signed-envelope and host-presentation digests", async () => {
    const envelope = {
      artifact_id: "cards-1",
      payload: { card_set_id: "cards-1" },
      signature: {
        algorithm: "Ed25519",
        key_id: "director-test",
        value: "signature",
      },
    };
    const presentation = {
      presentation_id: "presentation-1",
      presentation_digest: `sha256:${"2".repeat(64)}`,
      text_fallback: "CreatorCut card",
    };
    const adapter = {
      getCards: async () => ({ envelope, presentation }),
    } as unknown as CloudDirectorAdapter;
    const service = new CreatorCutMcpService(
      "/unused/project",
      async () => adapter,
    );

    await expect(service.getCards()).resolves.toMatchObject({
      envelope_id: "cards-1",
      envelope_digest: digestJcs(envelope),
      presentation_digest: presentation.presentation_digest,
      presentation,
    });
  });
});
