import { access, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { digestJcs } from "@agentmesh/creatorcut-protocol";

import {
  openCreatorCutProject,
  redoLocalRevision,
  undoLocalRevision,
  verifyMigratedVisualHandoff,
  type AuthorityMigrationFailureStage,
} from "../src/index.js";
import {
  migrateLegacyInternalProject,
  rollbackStorageAuthorityMigration,
} from "../src/storage-authority.js";
import {
  legacyFixture,
  project,
  timeline,
  visual,
} from "./storage-authority-fixtures.js";

async function assertMigratedSnapshots(
  projectDirectory: string,
): Promise<void> {
  const state = join(projectDirectory, ".creatorcut");
  expect((await readdir(join(state, "versions"))).sort()).toEqual([
    "0.json",
    "1.json",
    "2.json",
    "3.json",
  ]);
  for (let revision = 0; revision <= 3; revision += 1) {
    const snapshot = JSON.parse(
      await readFile(join(state, "versions", `${revision}.json`), "utf8"),
    ) as Record<string, any>;
    expect(snapshot.revision).toBe(revision);
    expect(snapshot.project.revision).toBe(revision);
    expect(snapshot.timeline.revision).toBe(revision);
    expect(snapshot.transcript.revision).toBe(revision);
    expect(snapshot.edit_brief.base_revision).toBe(revision);
    expect(
      digestJcs({
        framing: snapshot.timeline.canvas.framing,
        captions: snapshot.timeline.captions,
        effects: snapshot.timeline.effects,
        gain_millibels: snapshot.timeline.tracks[0].clips[0].gain_millibels,
      }),
    ).toBe(
      digestJcs({
        framing: timeline(revision).canvas.framing,
        captions: timeline(revision).captions,
        effects: timeline(revision).effects,
        gain_millibels: timeline(revision).tracks[0]!.clips[0]!.gain_millibels,
      }),
    );
  }
}

describe("single-authority legacy migration", () => {
  it("preserves transcript-span evidence and a nondefault approved edit brief", async () => {
    const fixture = await legacyFixture("transcript-brief");
    const state = join(fixture.projectDirectory, ".creatorcut");
    const transcript = {
      schema_version: "1.0-alpha",
      transcript_id: "transcript-migration-fixture",
      project_id: "migration-fixture",
      revision: 0,
      language_mode: "mixed",
      detected_language: "mixed",
      glossary: ["CreatorCut"],
      segments: [
        {
          segment_id: "segment-hook",
          source_asset_id: "asset-source",
          start_us: 0,
          end_us: 2_000_000,
          raw_text: "CreatorCut makes editing easier",
          display_text: "CreatorCut makes editing easier",
          tokens: [
            {
              token_id: "token-hook",
              text: "CreatorCut",
              start_us: 0,
              end_us: 800_000,
              language: "en",
              confidence: 0.98,
            },
          ],
        },
      ],
      silence_intervals: [
        {
          silence_id: "silence-tail",
          source_asset_id: "asset-source",
          start_us: 4_500_000,
          end_us: 4_900_000,
          detector: "ffmpeg_silencedetect",
        },
      ],
    };
    const editBrief = {
      schema_version: "1.0-alpha",
      brief_id: "brief-nondefault",
      project_id: "migration-fixture",
      base_revision: 0,
      card_answer_digest: `sha256:${"f".repeat(64)}`,
      platform: "xiaohongshu",
      target_duration_mode: "keep_original",
      editing_intensity: "story",
      audio_mode: "partial_voiceover",
      must_keep_option_ids: ["keep-hook"],
      terms: ["CreatorCut"],
      caption_style_id: "caption-premium",
      voice_id: "dayi",
      approved: true,
      source_facts: {
        source_duration_us: 5_000_000,
        language_mode: "mixed",
        has_video: true,
        has_audio: true,
      },
      prefilled_card_ids: ["card-platform"],
      created_at: "2026-08-09T00:00:00.000Z",
      updated_at: "2026-08-09T00:00:00.000Z",
    };
    await writeFile(join(state, "transcript.json"), JSON.stringify(transcript));
    await writeFile(join(state, "edit-brief.json"), JSON.stringify(editBrief));
    const transcriptAnchor = {
      kind: "transcript_span",
      segment_refs: ["segment-hook"],
      token_refs: ["token-hook"],
    };
    for (const relativePath of [
      "versions/1.json",
      "versions/3.json",
      "head.json",
    ]) {
      const path = join(state, relativePath);
      const value = JSON.parse(await readFile(path, "utf8"));
      const snapshot = relativePath === "head.json" ? value.snapshot : value;
      snapshot.visual_composition.visual_events[0].anchor = transcriptAnchor;
      await writeFile(path, JSON.stringify(value));
    }
    const candidatePath = join(state, "visual-composition-candidate.json");
    const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
    candidate.visual_events[0].anchor = transcriptAnchor;
    await writeFile(candidatePath, JSON.stringify(candidate));
    const chainPath = join(state, "fine-cut-card-chain.json");
    const chain = JSON.parse(await readFile(chainPath, "utf8"));
    chain.preview_approval_token = `visual_${digestJcs(candidate).slice(7, 19)}`;
    await writeFile(chainPath, JSON.stringify(chain));

    await migrateLegacyInternalProject(fixture.projectDirectory, {
      backupDirectory: fixture.backupDirectory,
    });
    const opened = await openCreatorCutProject(fixture.projectDirectory);
    expect(opened.transcript).toMatchObject({
      migration_status: "preserved",
      source_revision: 0,
      detected_language: "mixed",
      glossary: ["CreatorCut"],
    });
    expect(opened.editBrief).toMatchObject({
      approved: true,
      platform: "xiaohongshu",
      editing_intensity: "story",
      audio_mode: "partial_voiceover",
      migration_status: "preserved",
      source_base_revision: 0,
    });
    expect(opened.visualComposition?.visual_events[0]).toMatchObject({
      anchor: transcriptAnchor,
    });
  });

  it("fails public commands closed before migration and preserves the full chain", async () => {
    const fixture = await legacyFixture("full-chain");
    await expect(
      openCreatorCutProject(fixture.projectDirectory),
    ).rejects.toThrow("migrate before public status or mutations");

    const migrated = await migrateLegacyInternalProject(
      fixture.projectDirectory,
      {
        backupDirectory: fixture.backupDirectory,
        migrationId: "migration-full-chain",
      },
    );
    expect(migrated.status).toBe("migrated");
    expect(migrated.revision).toBe(3);
    const opened = await openCreatorCutProject(fixture.projectDirectory);
    expect(opened.project.revision).toBe(3);
    expect(opened.transcript.segments).toEqual([]);
    expect(opened.transcript.migration_status).toBe("missing_current");
    expect(opened.editBrief).toMatchObject({
      approved: false,
      migration_status: "missing_current",
    });
    expect(opened.visualComposition).toMatchObject({
      composition_id: "visual-approved",
      state: "active",
      project_revision: 3,
    });
    await assertMigratedSnapshots(fixture.projectDirectory);

    const state = join(fixture.projectDirectory, ".creatorcut");
    expect(
      JSON.parse(await readFile(join(state, "history.json"), "utf8")),
    ).toEqual({
      schema_version: "creatorcut-local-history/1.0",
      current_revision: 3,
      undo_stack: [2],
      redo_stack: [],
    });
    expect(
      (await readFile(join(state, "operations.jsonl"), "utf8"))
        .trim()
        .split("\n"),
    ).toHaveLength(3);
    expect(
      JSON.parse(
        await readFile(join(state, "fine-cut-card-chain.json"), "utf8"),
      ),
    ).toEqual(JSON.parse(fixture.auditBytes.chain.toString("utf8")));
    expect(
      JSON.parse(
        await readFile(
          join(state, "visual-composition-candidate.json"),
          "utf8",
        ),
      ),
    ).toEqual(JSON.parse(fixture.auditBytes.candidate.toString("utf8")));
    await expect(access(join(state, "head.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      access(join(fixture.backupDirectory, "metadata", "../media/source.mp4")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const retried = await migrateLegacyInternalProject(
      fixture.projectDirectory,
      {
        backupDirectory: fixture.backupDirectory,
        migrationId: "migration-full-chain",
      },
    );
    expect(retried.status).toBe("already_migrated");
  });

  for (const failureStage of [
    "after_pending_write",
    "after_staging_write",
    "after_versions_replace",
    "after_mirrors_replace",
    "after_legacy_head_remove",
    "after_legacy_report_remove",
    "after_legacy_import_remove",
    "after_legacy_studio_remove",
    "after_legacy_director_consent_remove",
    "after_legacy_director_state_remove",
    "after_legacy_preview_confirmation_remove",
    "before_initial_journal",
    "after_initial_journal",
    "before_authority_marker",
    "after_authority_marker",
  ] satisfies AuthorityMigrationFailureStage[]) {
    it(`recovers idempotently after ${failureStage}`, async () => {
      const fixture = await legacyFixture(failureStage);
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
          migrationId: `migration-${failureStage}`,
          failureStage,
        }),
      ).rejects.toThrow(`Injected failure: ${failureStage}`);
      const recovered = await migrateLegacyInternalProject(
        fixture.projectDirectory,
        {
          backupDirectory: fixture.backupDirectory,
          migrationId: `migration-${failureStage}`,
        },
      );
      expect(["migrated", "already_migrated"]).toContain(recovered.status);
      expect(recovered.recovered).toBe(true);
      await assertMigratedSnapshots(fixture.projectDirectory);
      expect(
        (await openCreatorCutProject(fixture.projectDirectory)).project
          .revision,
      ).toBe(3);
      await expect(
        access(
          join(
            fixture.projectDirectory,
            ".creatorcut",
            "pending-authority-migration.json",
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  it("serializes concurrent migration retries", async () => {
    const fixture = await legacyFixture("concurrent");
    const results = await Promise.all([
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
        migrationId: "migration-concurrent",
      }),
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
        migrationId: "migration-concurrent",
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "already_migrated",
      "migrated",
    ]);
    expect(
      (await openCreatorCutProject(fixture.projectDirectory)).project.revision,
    ).toBe(3);
  });

  it("supports public undo/redo and keeps the active visual sidecar", async () => {
    const fixture = await legacyFixture("interop");
    await migrateLegacyInternalProject(fixture.projectDirectory, {
      backupDirectory: fixture.backupDirectory,
    });
    const undone = await undoLocalRevision(fixture.projectDirectory);
    expect(undone.project.revision).toBe(4);
    expect(undone.visualComposition).toBeUndefined();
    expect(
      await verifyMigratedVisualHandoff(fixture.projectDirectory),
    ).toMatchObject({
      visual_state: "redo_available",
      redo_revision: 3,
      next: "edit_redo",
    });
    const redone = await redoLocalRevision(fixture.projectDirectory);
    expect(redone.project.revision).toBe(5);
    expect(redone.visualComposition).toMatchObject({
      composition_id: "visual-approved",
      state: "active",
      project_revision: 5,
    });
    expect(
      await verifyMigratedVisualHandoff(fixture.projectDirectory),
    ).toMatchObject({
      visual_state: "active",
      next: "export_plan",
    });
    const operations = (
      await readFile(
        join(fixture.projectDirectory, ".creatorcut", "operations.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(operations.slice(-2)).toMatchObject([
      {
        kind: "undo",
        revision: 4,
        base_revision: 3,
        restored_from_revision: 2,
      },
      {
        kind: "redo",
        revision: 5,
        base_revision: 4,
        restored_from_revision: 3,
      },
    ]);
  });

  it("preserves approved fine-cut evidence when the internal handoff is currently undone", async () => {
    const fixture = await legacyFixture("handoff-currently-undone");
    const state = join(fixture.projectDirectory, ".creatorcut");
    const revisionTwo = JSON.parse(
      await readFile(join(state, "versions", "2.json"), "utf8"),
    );
    const history = {
      schema_version: "1.0-alpha",
      current_revision: 2,
      undo_stack: [],
      redo_stack: [1],
    };
    const operations = (await readFile(join(state, "operations.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .slice(0, 2)
      .join("\n");
    await Promise.all([
      writeFile(
        join(state, "head.json"),
        `${JSON.stringify({
          schema_version: "1.0-alpha",
          snapshot: revisionTwo,
          history,
        })}\n`,
      ),
      writeFile(join(state, "project.json"), JSON.stringify(project(2))),
      writeFile(join(state, "timeline.json"), JSON.stringify(timeline(2))),
      writeFile(join(state, "history.json"), JSON.stringify(history)),
      writeFile(join(state, "operations.jsonl"), `${operations}\n`),
      rm(join(state, "versions", "3.json")),
    ]);
    const headBefore = await readFile(join(state, "head.json"));
    const chainBefore = await readFile(join(state, "fine-cut-card-chain.json"));
    const candidateBefore = await readFile(
      join(state, "visual-composition-candidate.json"),
    );

    await migrateLegacyInternalProject(fixture.projectDirectory, {
      backupDirectory: fixture.backupDirectory,
    });
    expect(
      await verifyMigratedVisualHandoff(fixture.projectDirectory),
    ).toMatchObject({
      visual_state: "redo_available",
      redo_revision: 1,
      next: "edit_redo",
      preview_approval_present: true,
      preview_binding_valid: true,
    });
    await rollbackStorageAuthorityMigration(
      fixture.projectDirectory,
      fixture.backupDirectory,
    );
    expect(await readFile(join(state, "head.json"))).toEqual(headBefore);
    expect(await readFile(join(state, "fine-cut-card-chain.json"))).toEqual(
      chainBefore,
    );
    expect(
      await readFile(join(state, "visual-composition-candidate.json")),
    ).toEqual(candidateBefore);

    await migrateLegacyInternalProject(fixture.projectDirectory, {
      backupDirectory: fixture.backupDirectory,
    });
    const redone = await redoLocalRevision(fixture.projectDirectory);
    expect(redone.visualComposition).toMatchObject({
      composition_id: "visual-approved",
      state: "active",
    });
    expect(
      await verifyMigratedVisualHandoff(fixture.projectDirectory),
    ).toMatchObject({ visual_state: "active", next: "export_plan" });
  }, 15_000);

  it("migrates a legal legacy project with no visual handoff into the ordinary public workflow", async () => {
    const fixture = await legacyFixture("no-visual-handoff");
    const state = join(fixture.projectDirectory, ".creatorcut");
    for (const revision of [1, 3]) {
      const versionPath = join(state, "versions", `${revision}.json`);
      const snapshot = JSON.parse(await readFile(versionPath, "utf8"));
      delete snapshot.visual_composition;
      await writeFile(versionPath, `${JSON.stringify(snapshot)}\n`);
    }
    const head = JSON.parse(await readFile(join(state, "head.json"), "utf8"));
    delete head.snapshot.visual_composition;
    await writeFile(join(state, "head.json"), `${JSON.stringify(head)}\n`);
    await Promise.all([
      rm(join(state, "rough-cut-confirmation.json")),
      rm(join(state, "fine-cut-card-chain.json")),
      rm(join(state, "visual-composition-candidate.json")),
    ]);
    const headBefore = await readFile(join(state, "head.json"));

    await migrateLegacyInternalProject(fixture.projectDirectory, {
      backupDirectory: fixture.backupDirectory,
    });
    expect(await verifyMigratedVisualHandoff(fixture.projectDirectory)).toEqual(
      {
        schema_version: "creatorcut-handoff-verification/1.0",
        project_id: "migration-fixture",
        current_revision: 3,
        migration_id: expect.any(String),
        visual_handoff_present: false,
        next: "public_workflow",
      },
    );
    expect(
      (await openCreatorCutProject(fixture.projectDirectory)).visualComposition,
    ).toBeUndefined();

    await rollbackStorageAuthorityMigration(
      fixture.projectDirectory,
      fixture.backupDirectory,
    );
    expect(await readFile(join(state, "head.json"))).toEqual(headBefore);
  });

  it("rolls back only before a public mutation and restores public fail-closed", async () => {
    const fixture = await legacyFixture("rollback");
    await migrateLegacyInternalProject(fixture.projectDirectory, {
      backupDirectory: fixture.backupDirectory,
      migrationId: "migration-rollback",
    });
    const rolledBack = await rollbackStorageAuthorityMigration(
      fixture.projectDirectory,
      fixture.backupDirectory,
    );
    expect(rolledBack.authority).toBe("internal-project-store");
    await expect(
      openCreatorCutProject(fixture.projectDirectory),
    ).rejects.toThrow("migrate before public status or mutations");
    const manifest = JSON.parse(
      await readFile(join(fixture.backupDirectory, "manifest.json"), "utf8"),
    ) as { files: Array<{ relative_path: string }> };
    for (const file of manifest.files) {
      expect(
        await readFile(
          join(fixture.projectDirectory, ".creatorcut", file.relative_path),
        ),
      ).toEqual(
        await readFile(
          join(fixture.backupDirectory, "metadata", file.relative_path),
        ),
      );
    }

    const mutatedFixture = await legacyFixture("rollback-after-mutation");
    await migrateLegacyInternalProject(mutatedFixture.projectDirectory, {
      backupDirectory: mutatedFixture.backupDirectory,
    });
    await undoLocalRevision(mutatedFixture.projectDirectory);
    await expect(
      rollbackStorageAuthorityMigration(
        mutatedFixture.projectDirectory,
        mutatedFixture.backupDirectory,
      ),
    ).rejects.toThrow("disabled after a public mutation");
  }, 15_000);
});
