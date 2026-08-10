import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { digestJcs } from "@agentmesh/creatorcut-protocol";
import {
  type LocalMediaProject,
  type LocalTimeline,
} from "@agentmesh/creatorcut-runtime";
import { migrateLegacyInternalProject } from "../../../packages/runtime/src/storage-authority.js";

function project(revision: number): LocalMediaProject {
  return {
    schema_version: "1.0-alpha",
    project_id: "cli-handoff-fixture",
    name: "CLI migrated handoff fixture",
    revision,
    created_at: "2026-08-09T00:00:00.000Z",
    updated_at: `2026-08-09T00:00:0${revision}.000Z`,
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
  };
}

function timeline(revision: number): LocalTimeline {
  return {
    schema_version: "1.0-alpha",
    timeline_id: "timeline-cli-handoff",
    project_id: "cli-handoff-fixture",
    revision,
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
  };
}

function visual(revision: number) {
  return {
    schema_version: "creatorcut-visual-composition/1.0",
    composition_id: "visual-cli-approved",
    project_id: "cli-handoff-fixture",
    timeline_id: "timeline-cli-handoff",
    rough_cut_revision: 0,
    project_revision: revision,
    state: "active" as const,
    visual_catalog_version: "creatorcut-visual-catalog/1.0",
    visual_catalog_digest: `sha256:${"b".repeat(64)}`,
    visual_events: [
      {
        visual_event_id: "event-cli-approved",
        base_revision: 0,
        anchor: { kind: "timeline_range", origin: "manual" },
        resolved_range: { start_us: 500_000, end_us: 2_000_000 },
        visual_intent: "hook",
        template_ref: {
          catalog_version: "creatorcut-visual-catalog/1.0",
          catalog_digest: `sha256:${"b".repeat(64)}`,
          template_id: "keyword_pulse_v1",
          template_digest: `sha256:${"d".repeat(64)}`,
        },
        bindings: { text: "CreatorCut", accent: "signal_yellow" },
        risk: "low",
        confidence_millis: 1000,
        enabled: true,
      },
    ],
    provenance: {
      fine_cut_chain_id: "fine-chain-cli-approved",
      answer_digest: `sha256:${"c".repeat(64)}`,
      origin: "local_rule",
    },
    created_at: "2026-08-09T00:00:00.000Z",
    updated_at: "2026-08-09T00:00:01.000Z",
  };
}

function snapshot(revision: number, hasVisual: boolean) {
  return {
    schema_version: "1.0-alpha",
    project: project(revision),
    timeline: timeline(revision),
    ...(hasVisual ? { visual_composition: visual(revision) } : {}),
    ...(revision === 2
      ? { restored_from_revision: 0 }
      : revision === 3
        ? { restored_from_revision: 1 }
        : {}),
  };
}

async function migratedFixture(visualHandoff: boolean): Promise<{
  projectDirectory: string;
  backupDirectory: string;
  approvalToken: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "creatorcut-cli-handoff-"));
  const projectDirectory = join(root, "handoff.creatorcut");
  const creatorcut = join(projectDirectory, ".creatorcut");
  const backupDirectory = join(root, "metadata-backup");
  await mkdir(join(creatorcut, "versions"), { recursive: true });
  await mkdir(join(projectDirectory, "media"), { recursive: true });
  await writeFile(join(projectDirectory, "media", "source.mp4"), "source");

  const snapshots = [
    snapshot(0, false),
    snapshot(1, visualHandoff),
    snapshot(2, false),
    snapshot(3, visualHandoff),
  ];
  for (const [revision, value] of snapshots.entries()) {
    await writeFile(
      join(creatorcut, "versions", `${revision}.json`),
      `${JSON.stringify(value)}\n`,
    );
  }
  const history = {
    schema_version: "1.0-alpha",
    current_revision: 3,
    undo_stack: [2],
    redo_stack: [],
  };
  const operations = [
    {
      transaction_id: "tx-cli-apply",
      kind: "commit",
      base_revision: 0,
      resulting_revision: 1,
      committed_at: "2026-08-09T00:00:01.000Z",
      operations: [{ operation_id: "visual-operation-cli-approved" }],
    },
    {
      transaction_id: "tx-cli-undo",
      kind: "undo",
      base_revision: 1,
      resulting_revision: 2,
      committed_at: "2026-08-09T00:00:02.000Z",
      operations: [],
      restored_from_revision: 0,
    },
    {
      transaction_id: "tx-cli-redo",
      kind: "redo",
      base_revision: 2,
      resulting_revision: 3,
      committed_at: "2026-08-09T00:00:03.000Z",
      operations: [],
      restored_from_revision: 1,
    },
  ];
  await Promise.all([
    writeFile(
      join(creatorcut, "head.json"),
      `${JSON.stringify({
        schema_version: "1.0-alpha",
        snapshot: snapshots[3],
        history,
      })}\n`,
    ),
    writeFile(
      join(creatorcut, "project.json"),
      `${JSON.stringify(project(3))}\n`,
    ),
    writeFile(
      join(creatorcut, "timeline.json"),
      `${JSON.stringify(timeline(3))}\n`,
    ),
    writeFile(join(creatorcut, "history.json"), `${JSON.stringify(history)}\n`),
    writeFile(
      join(creatorcut, "operations.jsonl"),
      `${operations.map((value) => JSON.stringify(value)).join("\n")}\n`,
    ),
    writeFile(
      join(creatorcut, "storage-authority.json"),
      `${JSON.stringify({
        schema_version: "creatorcut-storage-authority/1.0",
        authority: "internal-project-store",
        generation: 3,
        project_id: "cli-handoff-fixture",
        adopted_revision: 0,
        activated_at: "2026-08-09T00:00:00.000Z",
      })}\n`,
    ),
  ]);

  const candidate = { ...visual(0), state: "candidate" as const };
  const approvalToken = `visual_${digestJcs(candidate).slice(7, 19)}`;
  const previewBytes = Buffer.from("approved cli preview bytes");
  const previewSha256 = `sha256:${createHash("sha256")
    .update(previewBytes)
    .digest("hex")}`;
  const answers = [
    ["card_content_purpose", "purpose_product"],
    ["card_editing_density", "density_balanced"],
    ["card_visual_language", "visual_clean_premium"],
    ["card_motion_intensity", "motion_subtle"],
    ["card_subject_treatment", "subject_original"],
    ["card_caption_emphasis", "emphasis_balanced"],
    ["card_sfx_intensity", "sfx_light"],
    ["card_cta_style", "cta_none"],
  ].map(([cardId, optionId], index) => ({
    step_index: index + 1,
    card_id: cardId,
    option_id: optionId,
    presentation_digest: `sha256:${String(index + 1).repeat(64)}`,
    answer_digest:
      index === 7
        ? `sha256:${"c".repeat(64)}`
        : `sha256:${String(index + 1).repeat(64)}`,
    answered_at: `2026-08-09T00:00:0${index}.000Z`,
  }));
  if (visualHandoff) {
    await mkdir(join(projectDirectory, "previews"));
    await writeFile(
      join(projectDirectory, "previews", "approved-preview.mp4"),
      previewBytes,
    );
    await Promise.all([
      writeFile(
        join(creatorcut, "rough-cut-confirmation.json"),
        `${JSON.stringify({
          schema_version: "creatorcut-rough-cut-confirmation/1.0",
          confirmation_id: "rough-confirmation-cli-approved",
          project_id: "cli-handoff-fixture",
          rough_cut_revision: 0,
          approved: true,
          confirmed_at: "2026-08-09T00:00:00.000Z",
        })}\n`,
      ),
      writeFile(
        join(creatorcut, "visual-composition-candidate.json"),
        `${JSON.stringify(candidate)}\n`,
      ),
      writeFile(
        join(creatorcut, "fine-cut-card-chain.json"),
        `${JSON.stringify({
          schema_version: "creatorcut-fine-cut-card-chain/1.0",
          fine_cut_chain_id: "fine-chain-cli-approved",
          project_id: "cli-handoff-fixture",
          rough_cut_revision: 0,
          step_count: 8,
          current_step_index: 9,
          state: "applied",
          answers,
          previous_answer_digest: `sha256:${"c".repeat(64)}`,
          applied_revision: 1,
          candidate_composition_id: "visual-cli-approved",
          preview_relative_path: "previews/approved-preview.mp4",
          preview_approval_token: approvalToken,
          preview_sha256: previewSha256,
          created_at: "2026-08-09T00:00:00.000Z",
          updated_at: "2026-08-09T00:00:03.000Z",
        })}\n`,
      ),
    ]);
  }

  await migrateLegacyInternalProject(projectDirectory, { backupDirectory });
  return { projectDirectory, backupDirectory, approvalToken };
}

export function migratedHandoffFixture() {
  return migratedFixture(true);
}

export function migratedNoVisualFixture() {
  return migratedFixture(false);
}
