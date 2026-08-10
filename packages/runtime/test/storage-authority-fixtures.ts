import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { digestJcs } from "@agentmesh/creatorcut-protocol";

import type { LocalMediaProject, LocalTimeline } from "../src/index.js";

export function project(revision: number): LocalMediaProject {
  return {
    schema_version: "1.0-alpha",
    project_id: "migration-fixture",
    name: "Sanitized migration fixture",
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
      {
        asset_id: "asset-lut",
        kind: "lut",
        relative_path: "media/clean-look.cube",
        sha256: "e".repeat(64),
        duration_us: 0,
      },
    ],
  };
}

export function timeline(revision: number): LocalTimeline {
  return {
    schema_version: "1.0-alpha",
    timeline_id: "timeline-migration-fixture",
    project_id: "migration-fixture",
    revision,
    duration_us: 5_000_000,
    canvas: {
      width: 1920,
      height: 1080,
      framing: {
        mode: "center_crop",
        focus_x_millis: 500,
        focus_y_millis: 420,
      },
    },
    caption_safe_area: {
      left_px: 120,
      right_px: 120,
      top_px: 70,
      bottom_px: 120,
    },
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
            gain_millibels: -1_200,
          },
        ],
      },
    ],
    captions: [
      {
        caption_id: "caption-intro",
        start_us: 100_000,
        end_us: 900_000,
        text: "CreatorCut",
        style_id: "caption-clean",
      },
    ],
    effects: [
      {
        effect_id: "effect-clean-lut",
        type: "lut",
        target_clip_id: "clip-source",
        lut_asset_id: "asset-lut",
        intensity_millis: 650,
      },
    ],
  };
}

export function visual(revision: number) {
  return {
    schema_version: "creatorcut-visual-composition/1.0",
    composition_id: "visual-approved",
    project_id: "migration-fixture",
    timeline_id: "timeline-migration-fixture",
    rough_cut_revision: 0,
    project_revision: revision,
    state: "active" as const,
    visual_catalog_version: "creatorcut-visual-catalog/1.0",
    visual_catalog_digest: `sha256:${"b".repeat(64)}`,
    visual_events: [
      {
        visual_event_id: "event-approved",
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
      fine_cut_chain_id: "fine-chain-approved",
      answer_digest: `sha256:${"c".repeat(64)}`,
      origin: "local_rule",
    },
    created_at: "2026-08-09T00:00:00.000Z",
    updated_at: "2026-08-09T00:00:01.000Z",
  };
}

function legacySnapshot(revision: number, hasVisual: boolean) {
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

export async function legacyFixture(label: string): Promise<{
  projectDirectory: string;
  backupDirectory: string;
  auditBytes: { chain: Buffer; candidate: Buffer };
}> {
  const root = await mkdtemp(join(tmpdir(), `creatorcut-authority-${label}-`));
  const projectDirectory = join(root, "project.creatorcut");
  const state = join(projectDirectory, ".creatorcut");
  await mkdir(join(state, "versions"), { recursive: true });
  await mkdir(join(projectDirectory, "media"), { recursive: true });
  await writeFile(join(projectDirectory, "media", "source.mp4"), "media bytes");
  const snapshots = [
    legacySnapshot(0, false),
    legacySnapshot(1, true),
    legacySnapshot(2, false),
    legacySnapshot(3, true),
  ];
  for (const [revision, snapshot] of snapshots.entries()) {
    await writeFile(
      join(state, "versions", `${revision}.json`),
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
  }
  const history = {
    schema_version: "1.0-alpha",
    current_revision: 3,
    undo_stack: [2],
    redo_stack: [],
  };
  await Promise.all([
    writeFile(
      join(state, "head.json"),
      `${JSON.stringify(
        {
          schema_version: "1.0-alpha",
          snapshot: snapshots[3],
          history,
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(join(state, "project.json"), `${JSON.stringify(project(3))}\n`),
    writeFile(join(state, "timeline.json"), `${JSON.stringify(timeline(3))}\n`),
    writeFile(join(state, "history.json"), `${JSON.stringify(history)}\n`),
    writeFile(
      join(state, "operations.jsonl"),
      [
        {
          transaction_id: "tx-apply",
          kind: "commit",
          base_revision: 0,
          resulting_revision: 1,
          committed_at: "2026-08-09T00:00:01.000Z",
          operations: [{ operation_id: "visual-operation-approved" }],
        },
        {
          transaction_id: "tx-undo",
          kind: "undo",
          base_revision: 1,
          resulting_revision: 2,
          committed_at: "2026-08-09T00:00:02.000Z",
          operations: [],
          restored_from_revision: 0,
        },
        {
          transaction_id: "tx-redo",
          kind: "redo",
          base_revision: 2,
          resulting_revision: 3,
          committed_at: "2026-08-09T00:00:03.000Z",
          operations: [],
          restored_from_revision: 1,
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    ),
  ]);
  const candidateValue = {
    ...visual(0),
    state: "candidate",
  };
  const previewBytes = Buffer.from("approved preview bytes");
  const previewSha = `sha256:${createHash("sha256")
    .update(previewBytes)
    .digest("hex")}`;
  const previewToken = `visual_${digestJcs(candidateValue).slice(7, 19)}`;
  const answerOptions = [
    ["card_content_purpose", "purpose_product"],
    ["card_editing_density", "density_balanced"],
    ["card_visual_language", "visual_clean_premium"],
    ["card_motion_intensity", "motion_subtle"],
    ["card_subject_treatment", "subject_original"],
    ["card_caption_emphasis", "emphasis_balanced"],
    ["card_sfx_intensity", "sfx_light"],
    ["card_cta_style", "cta_none"],
  ];
  const answers = answerOptions.map(([cardId, optionId], index) => ({
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
  await mkdir(join(projectDirectory, "previews"));
  await writeFile(
    join(projectDirectory, "previews", "approved-preview.mp4"),
    previewBytes,
  );
  const chain = Buffer.from(
    `${JSON.stringify({
      schema_version: "creatorcut-fine-cut-card-chain/1.0",
      fine_cut_chain_id: "fine-chain-approved",
      project_id: "migration-fixture",
      rough_cut_revision: 0,
      step_count: 8,
      current_step_index: 9,
      state: "applied",
      answers,
      previous_answer_digest: `sha256:${"c".repeat(64)}`,
      applied_revision: 1,
      candidate_composition_id: "visual-approved",
      preview_relative_path: "previews/approved-preview.mp4",
      preview_approval_token: previewToken,
      preview_sha256: previewSha,
      created_at: "2026-08-09T00:00:00.000Z",
      updated_at: "2026-08-09T00:00:03.000Z",
    })}\n`,
  );
  const candidate = Buffer.from(`${JSON.stringify(candidateValue)}\n`);
  await writeFile(join(state, "fine-cut-card-chain.json"), chain);
  await writeFile(join(state, "visual-composition-candidate.json"), candidate);
  await writeFile(
    join(state, "rough-cut-confirmation.json"),
    `${JSON.stringify({
      schema_version: "creatorcut-rough-cut-confirmation/1.0",
      confirmation_id: "rough-confirmation-approved",
      project_id: "migration-fixture",
      rough_cut_revision: 0,
      approved: true,
      confirmed_at: "2026-08-09T00:00:00.000Z",
    })}\n`,
  );
  return {
    projectDirectory,
    backupDirectory: join(root, "metadata-backup"),
    auditBytes: { chain, candidate },
  };
}
