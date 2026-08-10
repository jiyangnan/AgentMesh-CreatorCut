import { createHash } from "node:crypto";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { digestJcs } from "@agentmesh/creatorcut-protocol";

const readCheckpoint = vi.hoisted(() => ({
  path: "",
  count: 0,
  triggerCount: 0,
  action: undefined as undefined | (() => Promise<void>),
  beforeOpenPath: "",
  beforeOpenAction: undefined as undefined | (() => Promise<void>),
  afterOpenPath: "",
  afterOpenAction: undefined as undefined | (() => Promise<void>),
  beforeReadFilePath: "",
  beforeReadFileAction: undefined as undefined | (() => Promise<void>),
  recordSyncs: false,
  syncedPaths: [] as string[],
  failSyncSuffix: "",
  recordDurabilityEvents: false,
  durabilityEvents: [] as string[],
  afterRenamePath: "",
  afterRenameCount: 0,
  afterRenameTriggerCount: 1,
  afterRenameAction: undefined as undefined | (() => Promise<void>),
  beforeRenamePath: "",
  beforeRenameAction: undefined as
    undefined | ((source: string, destination: string) => Promise<void>),
  afterRmPath: "",
  afterRmAction: undefined as undefined | (() => Promise<void>),
  beforeRmPath: "",
  beforeRmAction: undefined as undefined | (() => Promise<void>),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const interceptedReadFile: typeof actual.readFile = async (
    ...args: any[]
  ) => {
    if (
      String(args[0]) === readCheckpoint.beforeReadFilePath &&
      readCheckpoint.beforeReadFileAction
    ) {
      const action = readCheckpoint.beforeReadFileAction;
      readCheckpoint.beforeReadFileAction = undefined;
      await action();
    }
    const value = await (actual.readFile as any)(...args);
    if (String(args[0]) === readCheckpoint.path) {
      readCheckpoint.count += 1;
      if (
        readCheckpoint.count === readCheckpoint.triggerCount &&
        readCheckpoint.action
      ) {
        const action = readCheckpoint.action;
        readCheckpoint.action = undefined;
        await action();
      }
    }
    return value;
  };
  const interceptedOpen: typeof actual.open = async (...args: any[]) => {
    const openedPath = String(args[0]);
    if (
      openedPath === readCheckpoint.beforeOpenPath &&
      readCheckpoint.beforeOpenAction
    ) {
      const action = readCheckpoint.beforeOpenAction;
      readCheckpoint.beforeOpenAction = undefined;
      await action();
    }
    const handle = await (actual.open as any)(...args);
    if (
      openedPath === readCheckpoint.afterOpenPath &&
      readCheckpoint.afterOpenAction
    ) {
      const action = readCheckpoint.afterOpenAction;
      readCheckpoint.afterOpenAction = undefined;
      await action();
    }
    const originalReadFile = handle.readFile.bind(handle);
    handle.readFile = async (...readArgs: any[]) => {
      const value = await (originalReadFile as any)(...readArgs);
      if (openedPath === readCheckpoint.path) {
        readCheckpoint.count += 1;
        if (
          readCheckpoint.count === readCheckpoint.triggerCount &&
          readCheckpoint.action
        ) {
          const action = readCheckpoint.action;
          readCheckpoint.action = undefined;
          await action();
        }
      }
      return value;
    };
    if (String(args[1]) === "r") {
      const originalSync = handle.sync.bind(handle);
      handle.sync = async () => {
        const path = String(args[0]);
        if (readCheckpoint.recordSyncs) readCheckpoint.syncedPaths.push(path);
        if (readCheckpoint.recordDurabilityEvents) {
          readCheckpoint.durabilityEvents.push(`sync:${path}`);
        }
        if (
          readCheckpoint.failSyncSuffix &&
          path.endsWith(readCheckpoint.failSyncSuffix)
        ) {
          readCheckpoint.failSyncSuffix = "";
          throw new Error("Injected directory sync failure");
        }
        await originalSync();
      };
    }
    return handle;
  };
  const interceptedRename: typeof actual.rename = async (...args: any[]) => {
    if (
      String(args[1]) === readCheckpoint.beforeRenamePath &&
      readCheckpoint.beforeRenameAction
    ) {
      const action = readCheckpoint.beforeRenameAction;
      readCheckpoint.beforeRenameAction = undefined;
      await action(String(args[0]), String(args[1]));
    }
    await (actual.rename as any)(...args);
    if (String(args[1]) === readCheckpoint.afterRenamePath) {
      readCheckpoint.afterRenameCount += 1;
      if (
        readCheckpoint.afterRenameCount ===
          readCheckpoint.afterRenameTriggerCount &&
        readCheckpoint.afterRenameAction
      ) {
        const action = readCheckpoint.afterRenameAction;
        readCheckpoint.afterRenameAction = undefined;
        await action();
      }
    }
    if (readCheckpoint.recordDurabilityEvents) {
      readCheckpoint.durabilityEvents.push(
        `rename:${String(args[0])}->${String(args[1])}`,
      );
    }
  };
  const interceptedMkdir: typeof actual.mkdir = async (...args: any[]) => {
    const value = await (actual.mkdir as any)(...args);
    if (readCheckpoint.recordDurabilityEvents) {
      readCheckpoint.durabilityEvents.push(`mkdir:${String(args[0])}`);
    }
    return value;
  };
  const interceptedRm: typeof actual.rm = async (...args: any[]) => {
    if (
      String(args[0]) === readCheckpoint.beforeRmPath &&
      readCheckpoint.beforeRmAction
    ) {
      const action = readCheckpoint.beforeRmAction;
      readCheckpoint.beforeRmAction = undefined;
      await action();
    }
    await (actual.rm as any)(...args);
    if (
      String(args[0]) === readCheckpoint.afterRmPath &&
      readCheckpoint.afterRmAction
    ) {
      const action = readCheckpoint.afterRmAction;
      readCheckpoint.afterRmAction = undefined;
      await action();
    }
    if (readCheckpoint.recordDurabilityEvents) {
      readCheckpoint.durabilityEvents.push(`rm:${String(args[0])}`);
    }
  };
  return {
    ...actual,
    mkdir: interceptedMkdir,
    open: interceptedOpen,
    readFile: interceptedReadFile,
    rename: interceptedRename,
    rm: interceptedRm,
  };
});

import {
  commitLocalRevision,
  createCreatorCutProject,
  openCreatorCutProject,
  readLocalArtifact,
  redoLocalRevision,
  replaceLocalTranscript,
  undoLocalRevision,
  verifyMigratedVisualHandoff,
  writeLocalArtifact,
  type PublicMutationFailureStage,
} from "../src/index.js";
import {
  adoptLegacyPublicProject,
  migrateLegacyInternalProject,
  rollbackStorageAuthorityMigration,
  withPublicStorageMutation,
} from "../src/storage-authority.js";
import {
  legacyFixture,
  project,
  timeline,
} from "./storage-authority-fixtures.js";

async function publicFixture(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `creatorcut-public-${label}-`));
  const directory = join(root, "project.creatorcut");
  await createCreatorCutProject(directory, {
    project: project(0),
    timeline: timeline(0),
  });
  return directory;
}

async function removePublicAuthorityFiles(directory: string): Promise<void> {
  const state = join(directory, ".creatorcut");
  await Promise.all([
    unlink(join(state, "storage-authority.json")),
    unlink(join(state, "storage-mutations.jsonl")),
  ]);
}

async function mutateSynchronizedCurrentSnapshot(
  state: string,
  mutate: (snapshot: any) => void,
): Promise<void> {
  const history = JSON.parse(
    await readFile(join(state, "history.json"), "utf8"),
  );
  const snapshotPath = join(
    state,
    "versions",
    `${history.current_revision}.json`,
  );
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  mutate(snapshot);
  await Promise.all([
    writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`),
    writeFile(
      join(state, "project.json"),
      `${JSON.stringify(snapshot.project)}\n`,
    ),
    writeFile(
      join(state, "timeline.json"),
      `${JSON.stringify(snapshot.timeline)}\n`,
    ),
    writeFile(
      join(state, "transcript.json"),
      `${JSON.stringify(snapshot.transcript)}\n`,
    ),
    writeFile(
      join(state, "edit-brief.json"),
      `${JSON.stringify(snapshot.edit_brief)}\n`,
    ),
  ]);
}

async function exists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function rebindStageManifest(stageDirectory: string): Promise<void> {
  const canonical = join(stageDirectory, "canonical");
  const rootNames = (await readdir(canonical, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const versionNames = (
    await readdir(join(canonical, "versions"), {
      withFileTypes: true,
    })
  )
    .filter((entry) => entry.isFile())
    .map((entry) => `versions/${entry.name}`);
  const files = await Promise.all(
    [...rootNames, ...versionNames].sort().map(async (relativePath) => {
      const contents = await readFile(join(canonical, relativePath));
      return {
        relative_path: relativePath,
        sha256: sha256Hex(contents),
        size_bytes: contents.byteLength,
      };
    }),
  );
  const manifestPath = join(stageDirectory, "stage-complete.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const filesDigest = `sha256:${sha256Hex(
    files
      .map(
        (entry) =>
          `${entry.relative_path}\0${entry.size_bytes}\0${entry.sha256}\n`,
      )
      .join(""),
  )}`;
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, files, files_digest: filesDigest })}\n`,
  );
}

async function replaceBackupFileAndRebind(
  backupDirectory: string,
  relativePath: string,
  update: (value: unknown) => unknown,
): Promise<void> {
  const manifestPath = join(backupDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const filePath = join(
    backupDirectory,
    "metadata",
    ...relativePath.split("/"),
  );
  const next = Buffer.from(
    `${JSON.stringify(update(JSON.parse(await readFile(filePath, "utf8"))))}\n`,
    "utf8",
  );
  await writeFile(filePath, next);
  const entry = manifest.files.find(
    (candidate: { relative_path: string }) =>
      candidate.relative_path === relativePath,
  );
  if (!entry) {
    throw new Error(`Backup fixture entry is missing: ${relativePath}`);
  }
  entry.sha256 = sha256Hex(next);
  entry.size_bytes = next.byteLength;
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
}

async function rebindPublicMutationSnapshot(
  state: string,
  mutatePending: boolean,
): Promise<{ stage: string; pendingPath: string }> {
  const pendingPath = join(state, "pending-public-mutation.json");
  const pending = JSON.parse(await readFile(pendingPath, "utf8"));
  const stage = join(state, ".public-mutation", pending.transaction_id);
  const manifestPath = join(stage, "snapshot.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files = await Promise.all(
    manifest.files.map(async (entry: { relative_path: string }) => {
      const contents = await readFile(
        join(stage, "before", entry.relative_path),
      );
      return {
        relative_path: entry.relative_path,
        sha256: sha256Hex(contents),
        size_bytes: contents.byteLength,
      };
    }),
  );
  manifest.files_digest = `sha256:${sha256Hex(
    manifest.files
      .map(
        (entry: {
          relative_path: string;
          size_bytes: number;
          sha256: string;
        }) => `${entry.relative_path}\0${entry.size_bytes}\0${entry.sha256}\n`,
      )
      .join(""),
  )}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  if (mutatePending) {
    pending.before_snapshot_digest = digestJcs(manifest);
    await writeFile(pendingPath, `${JSON.stringify(pending)}\n`);
  }
  return { stage, pendingPath };
}

describe("storage authority path and backup hardening", () => {
  it("adopts and preserves a verified v0.2.1 commit, undo, and redo prefix", async () => {
    const directory = await publicFixture("adopt-v021-history");
    await commitLocalRevision(directory, {
      baseRevision: 0,
      nextTimeline: timeline(1),
      operationIds: ["legacy-commit-1"],
    });
    await commitLocalRevision(directory, {
      baseRevision: 1,
      nextTimeline: timeline(2),
      operationIds: ["legacy-commit-2"],
    });
    await undoLocalRevision(directory);
    await redoLocalRevision(directory);
    await openCreatorCutProject(directory);

    const state = join(directory, ".creatorcut");
    await Promise.all([
      writeFile(
        join(state, "director-consent.json"),
        `${JSON.stringify({ legacy: "consent" })}\n`,
      ),
    ]);
    const operationsPath = join(state, "operations.jsonl");
    const legacyOperations = (await readFile(operationsPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .map((entry) => {
        delete entry.kind;
        delete entry.restored_from_revision;
        return entry;
      });
    await writeFile(
      operationsPath,
      `${legacyOperations.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    for (const revision of [3, 4]) {
      const snapshotPath = join(state, "versions", `${revision}.json`);
      const snapshot = JSON.parse(
        await readFile(snapshotPath, "utf8"),
      ) as Record<string, unknown>;
      delete snapshot.restored_from_revision;
      await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    }
    await removePublicAuthorityFiles(directory);

    const preservedPaths = [
      "project.json",
      "timeline.json",
      "transcript.json",
      "edit-brief.json",
      "history.json",
      "operations.jsonl",
      "director-consent.json",
      ...[0, 1, 2, 3, 4].map((revision) => `versions/${revision}.json`),
    ];
    const before = new Map(
      await Promise.all(
        preservedPaths.map(
          async (relativePath) =>
            [relativePath, await readFile(join(state, relativePath))] as const,
        ),
      ),
    );

    await expect(
      adoptLegacyPublicProject(directory, { confirmLocal: true }),
    ).resolves.toMatchObject({
      authority: "public-runtime",
      adopted_revision: 4,
      current_revision: 4,
    });
    for (const [relativePath, contents] of before) {
      await expect(readFile(join(state, relativePath))).resolves.toEqual(
        contents,
      );
    }
    await expect(openCreatorCutProject(directory)).resolves.toMatchObject({
      project: { revision: 4 },
    });
    await expect(
      commitLocalRevision(directory, {
        baseRevision: 4,
        nextTimeline: timeline(5),
        operationIds: ["post-adoption-commit"],
      }),
    ).resolves.toMatchObject({ project: { revision: 5 } });
    await writeFile(
      join(state, "tasks", "legacy-task.json"),
      `${JSON.stringify({ legacy: "tampered" })}\n`,
    );
    await expect(openCreatorCutProject(directory)).rejects.toThrow(
      /canonical state/u,
    );
  });

  it("recovers only an exact orphan initial public-adoption journal", async () => {
    const directory = await publicFixture("adopt-orphan-journal");
    await removePublicAuthorityFiles(directory);
    const state = join(directory, ".creatorcut");
    const markerPath = join(state, "storage-authority.json");
    readCheckpoint.beforeRenamePath = join(
      await realpath(state),
      "storage-authority.json",
    );
    readCheckpoint.beforeRenameAction = async () => {
      throw new Error("Injected adoption marker publish failure");
    };

    await expect(
      adoptLegacyPublicProject(directory, { confirmLocal: true }),
    ).rejects.toThrow("Injected adoption marker publish failure");
    const orphanJournal = await readFile(
      join(state, "storage-mutations.jsonl"),
    );
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      adoptLegacyPublicProject(directory, { confirmLocal: true }),
    ).resolves.toMatchObject({ authority: "public-runtime", generation: 0 });
    await expect(
      readFile(join(state, "storage-mutations.jsonl")),
    ).resolves.toEqual(orphanJournal);
    await expect(openCreatorCutProject(directory)).resolves.toMatchObject({
      authorityGeneration: 0,
    });
  });

  it("rejects a typed commit that claims restore provenance", async () => {
    const directory = await publicFixture("adopt-typed-fake-restore");
    await commitLocalRevision(directory, {
      baseRevision: 0,
      nextTimeline: timeline(1),
      operationIds: ["typed-commit"],
    });
    await openCreatorCutProject(directory);
    const state = join(directory, ".creatorcut");
    const operationsPath = join(state, "operations.jsonl");
    const operations = (await readFile(operationsPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    operations[0]!.restored_from_revision = 0;
    await writeFile(
      operationsPath,
      `${operations.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    await removePublicAuthorityFiles(directory);

    await expect(
      adoptLegacyPublicProject(directory, { confirmLocal: true }),
    ).rejects.toThrow(/commit cannot claim a restore target/u);
    await expect(
      access(join(state, "storage-authority.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a root mirror that diverges from the current revision snapshot", async () => {
    const directory = await publicFixture("adopt-root-snapshot-split");
    const state = join(directory, ".creatorcut");
    const transcriptPath = join(state, "transcript.json");
    const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
    await writeFile(
      transcriptPath,
      `${JSON.stringify({ ...transcript, detected_language: "zh" }, null, 2)}\n`,
    );
    await removePublicAuthorityFiles(directory);

    await expect(
      adoptLegacyPublicProject(directory, { confirmLocal: true }),
    ).rejects.toThrow(/current transcript does not match/u);
    await expect(
      access(join(state, "storage-authority.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects synchronized invalid canonical shapes before writing adoption authority", async () => {
    const directory = await publicFixture("adopt-invalid-canonical-shape");
    const state = join(directory, ".creatorcut");
    await removePublicAuthorityFiles(directory);
    const projectPath = join(state, "project.json");
    const snapshotPath = join(state, "versions", "0.json");
    const rootProject = JSON.parse(await readFile(projectPath, "utf8"));
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    rootProject.assets = [];
    snapshot.project.assets = [];
    await Promise.all([
      writeFile(projectPath, `${JSON.stringify(rootProject)}\n`),
      writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`),
    ]);

    await expect(
      adoptLegacyPublicProject(directory, { confirmLocal: true }),
    ).rejects.toThrow(/project assets are missing/u);
    await expect(
      access(join(state, "storage-authority.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(state, "storage-mutations.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  const invalidSynchronizedAdoptionCases: ReadonlyArray<{
    label: string;
    mutate: (snapshot: any) => void;
  }> = [
    {
      label: "unsupported project schema",
      mutate: (snapshot) => {
        snapshot.project.schema_version = "2.0";
      },
    },
    {
      label: "unsupported timeline schema",
      mutate: (snapshot) => {
        snapshot.timeline.schema_version = "2.0";
      },
    },
    {
      label: "unsupported transcript schema",
      mutate: (snapshot) => {
        snapshot.transcript.schema_version = "2.0";
      },
    },
    {
      label: "unsupported edit brief schema",
      mutate: (snapshot) => {
        snapshot.edit_brief.schema_version = "2.0";
      },
    },
    {
      label: "duplicate asset ID",
      mutate: (snapshot) => {
        snapshot.project.assets.push({
          ...snapshot.project.assets[0],
          relative_path: "media/duplicate-source.mp4",
        });
      },
    },
    {
      label: "non-finishing Windows asset path",
      mutate: (snapshot) => {
        snapshot.project.assets[0].relative_path = "media\\source.mp4";
      },
    },
    {
      label: "traversing frozen generated asset path",
      mutate: (snapshot) => {
        snapshot.project.assets[0].relative_path =
          ".creatorcut\\generated\\..\\outside.mp4";
      },
    },
    {
      label: "duplicate track ID",
      mutate: (snapshot) => {
        snapshot.timeline.tracks.push({
          ...snapshot.timeline.tracks[0],
          clips: [],
        });
      },
    },
    {
      label: "duplicate clip ID",
      mutate: (snapshot) => {
        snapshot.timeline.tracks.push({
          track_id: "track-duplicate-clip",
          kind: "video",
          clips: [{ ...snapshot.timeline.tracks[0].clips[0] }],
        });
      },
    },
    {
      label: "duplicate caption ID",
      mutate: (snapshot) => {
        snapshot.timeline.captions.push({
          ...snapshot.timeline.captions[0],
        });
      },
    },
    {
      label: "duplicate effect ID",
      mutate: (snapshot) => {
        snapshot.timeline.effects.push({
          ...snapshot.timeline.effects[0],
        });
      },
    },
    {
      label: "duplicate silence ID",
      mutate: (snapshot) => {
        snapshot.transcript.silence_intervals = [
          {
            silence_id: "silence-duplicate",
            source_asset_id: "asset-source",
            start_us: 100_000,
            end_us: 200_000,
          },
          {
            silence_id: "silence-duplicate",
            source_asset_id: "asset-source",
            start_us: 300_000,
            end_us: 400_000,
          },
        ];
      },
    },
    {
      label: "unknown clip asset",
      mutate: (snapshot) => {
        snapshot.timeline.tracks[0].clips[0].asset_id = "asset-missing";
      },
    },
    {
      label: "non-media clip asset",
      mutate: (snapshot) => {
        snapshot.timeline.tracks[0].clips[0].asset_id = "asset-lut";
      },
    },
    {
      label: "clip source range beyond its asset",
      mutate: (snapshot) => {
        snapshot.timeline.tracks[0].clips[0].source_end_us = 5_000_001;
      },
    },
    {
      label: "clip range beyond its timeline",
      mutate: (snapshot) => {
        snapshot.timeline.tracks[0].clips[0].timeline_end_us = 5_000_001;
      },
    },
    {
      label: "unknown effect target clip",
      mutate: (snapshot) => {
        snapshot.timeline.effects[0].target_clip_id = "clip-missing";
      },
    },
    {
      label: "unknown LUT asset",
      mutate: (snapshot) => {
        snapshot.timeline.effects[0].lut_asset_id = "asset-missing";
      },
    },
    {
      label: "wrong LUT asset type",
      mutate: (snapshot) => {
        snapshot.timeline.effects[0].lut_asset_id = "asset-source";
      },
    },
    {
      label: "LUT effect targeting an audio clip",
      mutate: (snapshot) => {
        snapshot.project.assets.push({
          asset_id: "asset-audio",
          kind: "audio",
          relative_path: "media/audio.wav",
          sha256: "f".repeat(64),
          duration_us: 5_000_000,
        });
        snapshot.timeline.tracks.push({
          track_id: "track-music",
          kind: "music",
          clips: [
            {
              clip_id: "clip-audio",
              asset_id: "asset-audio",
              source_start_us: 0,
              source_end_us: 5_000_000,
              timeline_start_us: 0,
              timeline_end_us: 5_000_000,
            },
          ],
        });
        snapshot.timeline.effects[0].target_clip_id = "clip-audio";
      },
    },
  ];

  for (const { label, mutate } of invalidSynchronizedAdoptionCases) {
    it(`rejects synchronized invalid adoption metadata before writes: ${label}`, async () => {
      const directory = await publicFixture(
        `adopt-invalid-${label.replaceAll(/[^a-z0-9]/giu, "-")}`,
      );
      const state = join(directory, ".creatorcut");
      await removePublicAuthorityFiles(directory);
      await mutateSynchronizedCurrentSnapshot(state, mutate);

      await expect(
        adoptLegacyPublicProject(directory, { confirmLocal: true }),
      ).rejects.toThrow();
      await expect(
        access(join(state, "storage-authority.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        access(join(state, "storage-mutations.jsonl")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  for (const schemaVersion of ["1.0-alpha", "1.0"] as const) {
    it(`adopts frozen ${schemaVersion} metadata without rewriting legacy bytes`, async () => {
      const directory = await publicFixture(
        `adopt-frozen-${schemaVersion.replaceAll(".", "-")}`,
      );
      const state = join(directory, ".creatorcut");
      await removePublicAuthorityFiles(directory);
      await mutateSynchronizedCurrentSnapshot(state, (snapshot) => {
        snapshot.project.schema_version = schemaVersion;
        snapshot.timeline.schema_version = schemaVersion;
        snapshot.transcript.schema_version = schemaVersion;
        snapshot.edit_brief.schema_version = schemaVersion;
      });
      const preservedPaths = [
        "project.json",
        "timeline.json",
        "transcript.json",
        "edit-brief.json",
        "versions/0.json",
      ];
      const before = new Map(
        await Promise.all(
          preservedPaths.map(
            async (relativePath) =>
              [
                relativePath,
                await readFile(join(state, relativePath)),
              ] as const,
          ),
        ),
      );

      await expect(
        adoptLegacyPublicProject(directory, { confirmLocal: true }),
      ).resolves.toMatchObject({ authority: "public-runtime" });
      for (const [relativePath, bytes] of before) {
        await expect(readFile(join(state, relativePath))).resolves.toEqual(
          bytes,
        );
      }
    });
  }

  it("adopts frozen Windows asset paths while preserving exact metadata and retained binary bytes", async () => {
    const directory = await publicFixture("adopt-windows-runtime-artifacts");
    const state = join(directory, ".creatorcut");
    await removePublicAuthorityFiles(directory);
    await mutateSynchronizedCurrentSnapshot(state, (snapshot) => {
      snapshot.project.assets[0].relative_path =
        ".creatorcut\\generated\\legacy-source.mp4";
    });
    const generated = join(state, "generated", "legacy-source.mp4");
    const preview = join(state, "previews", "legacy-preview.mp4");
    await mkdir(dirname(generated), { recursive: true, mode: 0o700 });
    await mkdir(dirname(preview), { recursive: true, mode: 0o700 });
    await writeFile(generated, Buffer.from([0, 255, 1, 254, 2]));
    await writeFile(preview, Buffer.from([3, 253, 4, 252, 5]));
    const preserved = new Map(
      await Promise.all(
        [
          "project.json",
          "versions/0.json",
          "generated/legacy-source.mp4",
          "previews/legacy-preview.mp4",
        ].map(
          async (relativePath) =>
            [relativePath, await readFile(join(state, relativePath))] as const,
        ),
      ),
    );

    await expect(
      adoptLegacyPublicProject(directory, { confirmLocal: true }),
    ).resolves.toMatchObject({ authority: "public-runtime" });
    for (const [relativePath, bytes] of preserved) {
      await expect(readFile(join(state, relativePath))).resolves.toEqual(bytes);
    }
    await writeFile(preview, Buffer.from([9, 8, 7, 6]));
    await expect(openCreatorCutProject(directory)).resolves.toMatchObject({
      project: {
        assets: expect.arrayContaining([
          expect.objectContaining({
            relative_path: ".creatorcut\\generated\\legacy-source.mp4",
          }),
        ]),
      },
    });
  });

  it("preserves completed v0.2.1 transcription work through adoption and public-mutation recovery", async () => {
    const directory = await publicFixture("adopt-completed-transcription-work");
    await commitLocalRevision(directory, {
      baseRevision: 0,
      nextTimeline: timeline(1),
      operationIds: ["legacy-post-transcription-commit"],
    });
    const state = join(directory, ".creatorcut");
    await removePublicAuthorityFiles(directory);
    await rm(join(state, ".public-mutation"), { recursive: true, force: true });
    const currentProject = JSON.parse(
      await readFile(join(state, "project.json"), "utf8"),
    );
    const baseSnapshot = JSON.parse(
      await readFile(join(state, "versions", "0.json"), "utf8"),
    );
    const source = baseSnapshot.project.assets[0];
    const task = {
      schema_version: "creatorcut-transcription-task/1.0",
      task_id: "transcription:legacy-completed",
      project_id: currentProject.project_id,
      base_revision: 0,
      source_asset_id: source.asset_id,
      source_sha256: source.sha256,
      model_sha256: "b".repeat(64),
      language_mode: "auto",
      glossary: [],
      state: "completed",
      progress_millis: 1000,
      completed_steps: ["audio_prepared", "transcript_persisted"],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:01.000Z",
      result: {
        transcript_id: baseSnapshot.transcript.transcript_id,
        detected_language: "en",
        segment_count: baseSnapshot.transcript.segments.length,
        token_count: baseSnapshot.transcript.segments.reduce(
          (count: number, segment: { tokens: unknown[] }) =>
            count + segment.tokens.length,
          0,
        ),
      },
    };
    await writeFile(
      join(state, "tasks", "transcription.json"),
      `${JSON.stringify(task, null, 2)}\n`,
    );
    await writeFile(
      join(state, "tasks", "transcription-locator.json"),
      `${JSON.stringify({
        schema_version: "creatorcut-transcription-locator/1.0",
        source_path: "/tmp/legacy-source.mp4",
        model_path: "/tmp/legacy-model.bin",
        whisper_path: "whisper-cli",
        ffmpeg_path: "ffmpeg",
        ffprobe_path: "ffprobe",
      })}\n`,
    );
    const work = join(
      state,
      "tasks",
      "transcription-work",
      "0123456789abcdef01234567",
    );
    await mkdir(work, { recursive: true, mode: 0o700 });
    const audio = join(work, "audio.wav");
    const candidate = join(work, "candidate-auto.json");
    await writeFile(audio, Buffer.from([82, 73, 70, 70, 0, 255]));
    await writeFile(candidate, Buffer.from('{"legacy":true}\n'));
    const beforeAudio = await readFile(audio);
    const beforeCandidate = await readFile(candidate);

    await expect(
      adoptLegacyPublicProject(directory, { confirmLocal: true }),
    ).resolves.toMatchObject({ authority: "public-runtime" });
    await expect(
      withPublicStorageMutation(
        state,
        "retained_work_recovery",
        async (marker) => {
          await writeFile(
            join(state, "tasks", "recovery-probe.json"),
            '{"temporary":true}\n',
          );
          return {
            value: undefined,
            currentRevision: marker.current_revision,
          };
        },
        { failureStage: "after_mutation_body" },
      ),
    ).rejects.toThrow("Injected failure: after_mutation_body");
    await expect(openCreatorCutProject(directory)).resolves.toMatchObject({
      authorityGeneration: 0,
    });
    await expect(readFile(audio)).resolves.toEqual(beforeAudio);
    await expect(readFile(candidate)).resolves.toEqual(beforeCandidate);
    await expect(
      access(join(state, "tasks", "recovery-probe.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      commitLocalRevision(directory, {
        baseRevision: 1,
        nextTimeline: timeline(2),
        operationIds: ["post-adoption-retained-work-commit"],
      }),
    ).resolves.toMatchObject({ project: { revision: 2 } });
    await expect(readFile(audio)).resolves.toEqual(beforeAudio);
    await expect(readFile(candidate)).resolves.toEqual(beforeCandidate);
    await expect(openCreatorCutProject(directory)).resolves.toMatchObject({
      project: { revision: 2 },
    });
  });

  it("adopts a completed v0.2.1 transcription after a same-revision transcript replacement", async () => {
    const directory = await publicFixture(
      "adopt-completed-transcription-after-replace",
    );
    const opened = await openCreatorCutProject(directory);
    const source = opened.project.assets[0];
    if (!source) throw new Error("Expected a source asset");
    const completedTask = {
      schema_version: "creatorcut-transcription-task/1.0",
      task_id: "transcription:legacy-before-manual-replace",
      project_id: opened.project.project_id,
      base_revision: opened.project.revision,
      source_asset_id: source.asset_id,
      source_sha256: source.sha256,
      model_sha256: "b".repeat(64),
      language_mode: "auto",
      glossary: [],
      state: "completed",
      progress_millis: 1000,
      completed_steps: ["audio_prepared", "transcript_persisted"],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:01.000Z",
      result: {
        transcript_id: opened.transcript.transcript_id,
        detected_language: "other",
        segment_count: opened.transcript.segments.length,
        token_count: opened.transcript.segments.reduce(
          (count, segment) => count + segment.tokens.length,
          0,
        ),
      },
    } as const;
    await writeLocalArtifact(directory, "tasks/transcription-locator.json", {
      schema_version: "creatorcut-transcription-locator/1.0",
      source_path: "/tmp/legacy-source.mp4",
      model_path: "/tmp/legacy-model.bin",
      whisper_path: "whisper-cli",
      ffmpeg_path: "ffmpeg",
      ffprobe_path: "ffprobe",
    });
    await writeLocalArtifact(
      directory,
      "tasks/transcription.json",
      completedTask,
    );
    await replaceLocalTranscript(directory, {
      ...opened.transcript,
      transcript_id: "transcript:manual-same-revision-replacement",
    });
    await commitLocalRevision(directory, {
      baseRevision: 0,
      nextTimeline: timeline(1),
      operationIds: ["legacy-commit-after-manual-transcript-replace"],
    });

    const state = join(directory, ".creatorcut");
    const taskBytes = await readFile(
      join(state, "tasks", "transcription.json"),
    );
    await removePublicAuthorityFiles(directory);
    await rm(join(state, ".public-mutation"), {
      recursive: true,
      force: true,
    });

    await expect(
      adoptLegacyPublicProject(directory, { confirmLocal: true }),
    ).resolves.toMatchObject({ authority: "public-runtime" });
    await expect(
      readFile(join(state, "tasks", "transcription.json")),
    ).resolves.toEqual(taskBytes);
    await expect(openCreatorCutProject(directory)).resolves.toMatchObject({
      project: { revision: 1 },
      transcript: {
        transcript_id: "transcript:manual-same-revision-replacement",
      },
    });
  });

  for (const taskState of [
    "queued",
    "running",
    "failed",
    "cancelled",
  ] as const) {
    it(`rejects resumable v0.2.1 transcription work before adoption writes: ${taskState}`, async () => {
      const directory = await publicFixture(`adopt-transcription-${taskState}`);
      const state = join(directory, ".creatorcut");
      await removePublicAuthorityFiles(directory);
      const currentProject = JSON.parse(
        await readFile(join(state, "project.json"), "utf8"),
      );
      const source = currentProject.assets[0];
      await writeFile(
        join(state, "tasks", "transcription.json"),
        `${JSON.stringify({
          schema_version: "creatorcut-transcription-task/1.0",
          task_id: `transcription:legacy-${taskState}`,
          project_id: currentProject.project_id,
          base_revision: currentProject.revision,
          source_asset_id: source.asset_id,
          source_sha256: source.sha256,
          model_sha256: "b".repeat(64),
          language_mode: "auto",
          glossary: [],
          state: taskState,
          progress_millis: taskState === "queued" ? 0 : 500,
          completed_steps: [],
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:01.000Z",
          ...(taskState === "failed"
            ? { error: { code: "legacy_failure", message: "retryable" } }
            : {}),
        })}\n`,
      );
      await writeFile(
        join(state, "tasks", "transcription-locator.json"),
        `${JSON.stringify({
          schema_version: "creatorcut-transcription-locator/1.0",
          source_path: "/tmp/legacy-source.mp4",
          model_path: "/tmp/legacy-model.bin",
          whisper_path: "whisper-cli",
          ffmpeg_path: "ffmpeg",
          ffprobe_path: "ffprobe",
        })}\n`,
      );
      const work = join(
        state,
        "tasks",
        "transcription-work",
        "0123456789abcdef01234567",
      );
      await mkdir(work, { recursive: true, mode: 0o700 });
      await writeFile(join(work, "audio.wav"), "preserve-resumable-work");

      await expect(
        adoptLegacyPublicProject(directory, { confirmLocal: true }),
      ).rejects.toThrow(/transcription task.*not completed/iu);
      await expect(readFile(join(work, "audio.wav"), "utf8")).resolves.toBe(
        "preserve-resumable-work",
      );
      await expect(
        access(join(state, "storage-authority.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        access(join(state, "storage-mutations.jsonl")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  it("rejects a v0.2.1 preview confirmation before adoption writes without deleting preview bytes", async () => {
    const directory = await publicFixture("adopt-pending-preview");
    const state = join(directory, ".creatorcut");
    await removePublicAuthorityFiles(directory);
    await writeFile(
      join(state, "preview-confirmation.json"),
      '{"legacy":"pending-preview"}\n',
    );
    const preview = join(state, "previews", "pending-preview.mp4");
    await mkdir(dirname(preview), { recursive: true, mode: 0o700 });
    await writeFile(preview, "preserve-pending-preview");

    await expect(
      adoptLegacyPublicProject(directory, { confirmLocal: true }),
    ).rejects.toThrow(/pending storage/iu);
    await expect(readFile(preview, "utf8")).resolves.toBe(
      "preserve-pending-preview",
    );
    await expect(
      access(join(state, "storage-authority.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(state, "storage-mutations.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  for (const taskState of [
    "queued",
    "running",
    "finalizing",
    "failed",
    "cancelled",
  ] as const) {
    it(`rejects resumable v0.2.1 export metadata before adoption writes: ${taskState}`, async () => {
      const directory = await publicFixture(`adopt-export-${taskState}`);
      const state = join(directory, ".creatorcut");
      await removePublicAuthorityFiles(directory);
      const currentProject = JSON.parse(
        await readFile(join(state, "project.json"), "utf8"),
      );
      await writeFile(
        join(state, "tasks", "export.json"),
        `${JSON.stringify({
          schema_version: "creatorcut-export-task/1.0",
          task_id: `export:legacy-${taskState}`,
          project_id: currentProject.project_id,
          base_revision: currentProject.revision,
          state: taskState,
          progress_millis: taskState === "queued" ? 0 : 500,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:01.000Z",
          ...(taskState === "failed"
            ? { error: { code: "legacy_failure", message: "retryable" } }
            : {}),
        })}\n`,
      );
      await writeFile(
        join(state, "tasks", "export-locator.json"),
        `${JSON.stringify({
          schema_version: "creatorcut-export-locator/1.0",
          output_path: "/tmp/legacy-export.mp4",
          ffmpeg_path: "ffmpeg",
          ffprobe_path: "ffprobe",
          overwrite: false,
        })}\n`,
      );

      await expect(
        adoptLegacyPublicProject(directory, { confirmLocal: true }),
      ).rejects.toThrow(/export task.*not completed/iu);
      await expect(
        access(join(state, "storage-authority.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        access(join(state, "storage-mutations.jsonl")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  it("adopts and preserves strict completed v0.2.1 export metadata", async () => {
    const directory = await publicFixture("adopt-completed-export");
    await commitLocalRevision(directory, {
      baseRevision: 0,
      nextTimeline: timeline(1),
      operationIds: ["legacy-post-export-commit"],
    });
    const state = join(directory, ".creatorcut");
    await removePublicAuthorityFiles(directory);
    await rm(join(state, ".public-mutation"), { recursive: true, force: true });
    const currentProject = JSON.parse(
      await readFile(join(state, "project.json"), "utf8"),
    );
    const taskPath = join(state, "tasks", "export.json");
    await writeFile(
      taskPath,
      `${JSON.stringify(
        {
          schema_version: "creatorcut-export-task/1.0",
          task_id: "export:legacy-completed",
          project_id: currentProject.project_id,
          base_revision: 0,
          state: "completed",
          progress_millis: 1000,
          output_sha256: "c".repeat(64),
          output_path: "/tmp/legacy-export.mp4",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:01.000Z",
          result: {
            schema_version: "creatorcut-render-result/1.0",
            output_path: "/tmp/legacy-export.mp4",
            output_sha256: "c".repeat(64),
            duration_us: 5_000_000,
            width: 1920,
            height: 1080,
            quality: "export",
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(state, "tasks", "export-locator.json"),
      `${JSON.stringify({
        schema_version: "creatorcut-export-locator/1.0",
        output_path: "/tmp/legacy-export.mp4",
        ffmpeg_path: "ffmpeg",
        ffprobe_path: "ffprobe",
        overwrite: false,
      })}\n`,
    );
    const locatorPath = join(state, "tasks", "export-locator.json");
    const before = new Map([
      [taskPath, await readFile(taskPath)],
      [locatorPath, await readFile(locatorPath)],
    ]);

    await expect(
      adoptLegacyPublicProject(directory, { confirmLocal: true }),
    ).resolves.toMatchObject({ authority: "public-runtime" });
    for (const [path, bytes] of before) {
      await expect(readFile(path)).resolves.toEqual(bytes);
    }
  });

  for (const taskCase of [
    { kind: "export", violation: "wrong project" },
    { kind: "export", violation: "missing result" },
    { kind: "export", violation: "incomplete progress" },
    { kind: "export", violation: "retained error" },
    { kind: "export", violation: "top-level output mismatch" },
    { kind: "export", violation: "locator output mismatch" },
    { kind: "export", violation: "preview result" },
    { kind: "transcription", violation: "wrong source digest" },
    { kind: "transcription", violation: "missing result" },
    { kind: "transcription", violation: "incomplete progress" },
    { kind: "transcription", violation: "retained error" },
    { kind: "transcription", violation: "missing completed step" },
  ] as const) {
    it(`rejects a completed legacy ${taskCase.kind} task with ${taskCase.violation}`, async () => {
      const directory = await publicFixture(
        `adopt-completed-${taskCase.kind}-${taskCase.violation.replaceAll(" ", "-")}`,
      );
      const state = join(directory, ".creatorcut");
      await removePublicAuthorityFiles(directory);
      const currentProject = JSON.parse(
        await readFile(join(state, "project.json"), "utf8"),
      );
      const source = currentProject.assets[0];
      if (taskCase.kind === "export") {
        await writeFile(
          join(state, "tasks", "export.json"),
          `${JSON.stringify({
            schema_version: "creatorcut-export-task/1.0",
            task_id: "export:legacy-boundary",
            project_id:
              taskCase.violation === "wrong project"
                ? "other-project"
                : currentProject.project_id,
            base_revision: currentProject.revision,
            state: "completed",
            progress_millis:
              taskCase.violation === "incomplete progress" ? 999 : 1000,
            output_sha256:
              taskCase.violation === "top-level output mismatch"
                ? "d".repeat(64)
                : "c".repeat(64),
            output_path: "/tmp/legacy-export.mp4",
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:01.000Z",
            ...(taskCase.violation === "retained error"
              ? { error: { code: "stale", message: "must be absent" } }
              : {}),
            ...(taskCase.violation === "missing result"
              ? {}
              : {
                  result: {
                    schema_version: "creatorcut-render-result/1.0",
                    output_path: "/tmp/legacy-export.mp4",
                    output_sha256: "c".repeat(64),
                    duration_us: 5_000_000,
                    width: 1920,
                    height: 1080,
                    quality:
                      taskCase.violation === "preview result"
                        ? "preview"
                        : "export",
                  },
                }),
          })}\n`,
        );
        await writeFile(
          join(state, "tasks", "export-locator.json"),
          `${JSON.stringify({
            schema_version: "creatorcut-export-locator/1.0",
            output_path:
              taskCase.violation === "locator output mismatch"
                ? "/tmp/other-export.mp4"
                : "/tmp/legacy-export.mp4",
            ffmpeg_path: "ffmpeg",
            ffprobe_path: "ffprobe",
            overwrite: false,
          })}\n`,
        );
      } else {
        await writeFile(
          join(state, "tasks", "transcription.json"),
          `${JSON.stringify({
            schema_version: "creatorcut-transcription-task/1.0",
            task_id: "transcription:legacy-boundary",
            project_id: currentProject.project_id,
            base_revision: currentProject.revision,
            source_asset_id: source.asset_id,
            source_sha256:
              taskCase.violation === "wrong source digest"
                ? "d".repeat(64)
                : source.sha256,
            model_sha256: "b".repeat(64),
            language_mode: "auto",
            glossary: [],
            state: "completed",
            progress_millis:
              taskCase.violation === "incomplete progress" ? 999 : 1000,
            completed_steps:
              taskCase.violation === "missing completed step"
                ? ["audio_prepared"]
                : ["transcript_persisted"],
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:01.000Z",
            ...(taskCase.violation === "retained error"
              ? { error: { code: "stale", message: "must be absent" } }
              : {}),
            ...(taskCase.violation === "missing result"
              ? {}
              : {
                  result: {
                    transcript_id: "transcript:migration-fixture",
                    detected_language: "en",
                    segment_count: 0,
                    token_count: 0,
                  },
                }),
          })}\n`,
        );
        await writeFile(
          join(state, "tasks", "transcription-locator.json"),
          `${JSON.stringify({
            schema_version: "creatorcut-transcription-locator/1.0",
            source_path: "/tmp/legacy-source.mp4",
            model_path: "/tmp/legacy-model.bin",
            whisper_path: "whisper-cli",
            ffmpeg_path: "ffmpeg",
            ffprobe_path: "ffprobe",
          })}\n`,
        );
      }

      await expect(
        adoptLegacyPublicProject(directory, { confirmLocal: true }),
      ).rejects.toThrow(/bound|result|completed|output|transcript/iu);
      await expect(
        access(join(state, "storage-authority.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        access(join(state, "storage-mutations.jsonl")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  for (const taskCase of [
    { label: "unknown task", name: "legacy-task.json" },
    { label: "Director task", name: "director-remote-effect.json" },
  ] as const) {
    it(`rejects a ${taskCase.label} before adoption writes`, async () => {
      const directory = await publicFixture(
        `adopt-${taskCase.label.replaceAll(" ", "-")}`,
      );
      const state = join(directory, ".creatorcut");
      await removePublicAuthorityFiles(directory);
      await writeFile(
        join(state, "tasks", taskCase.name),
        '{"legacy":"unsupported"}\n',
      );

      await expect(
        adoptLegacyPublicProject(directory, { confirmLocal: true }),
      ).rejects.toThrow(/task.*cannot be adopted/iu);
      await expect(
        access(join(state, "storage-authority.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        access(join(state, "storage-mutations.jsonl")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  for (const orphan of ["export.json", "transcription-locator.json"] as const) {
    it(`rejects orphan v0.2.1 task metadata before adoption writes: ${orphan}`, async () => {
      const directory = await publicFixture(
        `adopt-orphan-${orphan.replaceAll(".", "-")}`,
      );
      const state = join(directory, ".creatorcut");
      await removePublicAuthorityFiles(directory);
      await writeFile(join(state, "tasks", orphan), "{}\n");

      await expect(
        adoptLegacyPublicProject(directory, { confirmLocal: true }),
      ).rejects.toThrow(/task.*pair|artifact/iu);
      await expect(
        access(join(state, "storage-authority.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        access(join(state, "storage-mutations.jsonl")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  for (const retainedDirectory of ["generated", "previews"] as const) {
    it(`rejects a symbolic-link legacy ${retainedDirectory} directory without touching its target`, async () => {
      const directory = await publicFixture(
        `adopt-symlink-${retainedDirectory}`,
      );
      const state = join(directory, ".creatorcut");
      await removePublicAuthorityFiles(directory);
      const outside = join(dirname(directory), `${retainedDirectory}-outside`);
      await mkdir(outside);
      await writeFile(join(outside, "sentinel.bin"), "preserve-external");
      await symlink(outside, join(state, retainedDirectory));

      await expect(
        adoptLegacyPublicProject(directory, { confirmLocal: true }),
      ).rejects.toThrow(/retained runtime directory|symbolic link/iu);
      await expect(
        readFile(join(outside, "sentinel.bin"), "utf8"),
      ).resolves.toBe("preserve-external");
      await expect(
        access(join(state, "storage-authority.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  it("validates every historical revision before writing adoption authority", async () => {
    const directory = await publicFixture("adopt-invalid-history-graph");
    await commitLocalRevision(directory, {
      baseRevision: 0,
      nextTimeline: timeline(1),
      operationIds: ["legacy-commit"],
    });
    await openCreatorCutProject(directory);
    const state = join(directory, ".creatorcut");
    await removePublicAuthorityFiles(directory);
    const historicalPath = join(state, "versions", "0.json");
    const historical = JSON.parse(await readFile(historicalPath, "utf8"));
    historical.timeline.tracks[0].clips[0].asset_id = "asset-missing";
    await writeFile(historicalPath, `${JSON.stringify(historical)}\n`);

    await expect(
      adoptLegacyPublicProject(directory, { confirmLocal: true }),
    ).rejects.toThrow(/unknown asset/u);
    await expect(
      access(join(state, "storage-authority.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(state, "storage-mutations.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires 1.0 component schemas after canonical internal migration", async () => {
    const fixture = await legacyFixture("canonical-schema-policy");
    await migrateLegacyInternalProject(fixture.projectDirectory, {
      backupDirectory: fixture.backupDirectory,
    });
    const state = join(fixture.projectDirectory, ".creatorcut");
    await mutateSynchronizedCurrentSnapshot(state, (snapshot) => {
      snapshot.project.schema_version = "1.0-alpha";
    });

    await expect(
      openCreatorCutProject(fixture.projectDirectory),
    ).rejects.toThrow(/project schema is unsupported/u);
  });

  it("rejects frozen Windows separators after canonical internal migration", async () => {
    const fixture = await legacyFixture("canonical-windows-path-policy");
    await migrateLegacyInternalProject(fixture.projectDirectory, {
      backupDirectory: fixture.backupDirectory,
    });
    const state = join(fixture.projectDirectory, ".creatorcut");
    await mutateSynchronizedCurrentSnapshot(state, (snapshot) => {
      snapshot.project.assets[0].relative_path =
        ".creatorcut\\generated\\legacy-source.mp4";
    });

    await expect(
      openCreatorCutProject(fixture.projectDirectory),
    ).rejects.toThrow(/unsafe metadata path/iu);
  });

  it("rejects a reserved legacy restore record that does not match history", async () => {
    const directory = await publicFixture("adopt-invalid-legacy-restore");
    await commitLocalRevision(directory, {
      baseRevision: 0,
      nextTimeline: timeline(1),
      operationIds: ["legacy-commit"],
    });
    await openCreatorCutProject(directory);
    const state = join(directory, ".creatorcut");
    const operationsPath = join(state, "operations.jsonl");
    const operation = JSON.parse(
      (await readFile(operationsPath, "utf8")).trim(),
    ) as Record<string, unknown>;
    delete operation.kind;
    operation.operation_ids = ["local:undo:0"];
    await writeFile(operationsPath, `${JSON.stringify(operation)}\n`);
    await removePublicAuthorityFiles(directory);

    await expect(
      adoptLegacyPublicProject(directory, { confirmLocal: true }),
    ).rejects.toThrow(/legacy restore operation does not match/u);
    await expect(
      access(join(state, "storage-authority.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a reserved legacy restore ID hidden among multiple IDs", async () => {
    const directory = await publicFixture("adopt-multi-id-legacy-restore");
    await commitLocalRevision(directory, {
      baseRevision: 0,
      nextTimeline: timeline(1),
      operationIds: ["legacy-commit"],
    });
    await openCreatorCutProject(directory);
    const state = join(directory, ".creatorcut");
    const operationsPath = join(state, "operations.jsonl");
    const operation = JSON.parse(
      (await readFile(operationsPath, "utf8")).trim(),
    ) as Record<string, unknown>;
    delete operation.kind;
    operation.operation_ids = ["local:undo:0", "disguise"];
    await writeFile(operationsPath, `${JSON.stringify(operation)}\n`);
    await removePublicAuthorityFiles(directory);

    await expect(
      adoptLegacyPublicProject(directory, { confirmLocal: true }),
    ).rejects.toThrow(/restore operation ID is invalid/u);
    await expect(
      access(join(state, "storage-authority.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a kindless operation beyond the adopted legacy boundary", async () => {
    const directory = await publicFixture("adopt-kindless-after-boundary");
    await removePublicAuthorityFiles(directory);
    await adoptLegacyPublicProject(directory, { confirmLocal: true });
    await commitLocalRevision(directory, {
      baseRevision: 0,
      nextTimeline: timeline(1),
      operationIds: ["post-adoption-typed-commit"],
    });
    const operationsPath = join(directory, ".creatorcut", "operations.jsonl");
    const operation = JSON.parse(
      (await readFile(operationsPath, "utf8")).trim(),
    ) as Record<string, unknown>;
    delete operation.kind;
    await writeFile(operationsPath, `${JSON.stringify(operation)}\n`);

    await expect(openCreatorCutProject(directory)).rejects.toThrow(
      /legacy operation log entry is not allowed/u,
    );
  });

  it("rejects a truncated legacy history that does not start at revision zero", async () => {
    const directory = await publicFixture("adopt-truncated-history");
    await commitLocalRevision(directory, {
      baseRevision: 0,
      nextTimeline: timeline(1),
      operationIds: ["legacy-commit-1"],
    });
    await commitLocalRevision(directory, {
      baseRevision: 1,
      nextTimeline: timeline(2),
      operationIds: ["legacy-commit-2"],
    });
    await openCreatorCutProject(directory);
    const state = join(directory, ".creatorcut");
    await unlink(join(state, "versions", "0.json"));
    const operationsPath = join(state, "operations.jsonl");
    const operations = (await readFile(operationsPath, "utf8"))
      .trimEnd()
      .split("\n");
    await writeFile(operationsPath, `${operations[1]}\n`);
    const historyPath = join(state, "history.json");
    const history = JSON.parse(await readFile(historyPath, "utf8"));
    await writeFile(
      historyPath,
      `${JSON.stringify({ ...history, undo_stack: [1] }, null, 2)}\n`,
    );
    await removePublicAuthorityFiles(directory);

    await expect(
      adoptLegacyPublicProject(directory, { confirmLocal: true }),
    ).rejects.toThrow(/complete history from revision 0/u);
    await expect(
      access(join(state, "storage-authority.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores but retains verified abandoned atomic-write temps during adoption", async () => {
    const directory = await publicFixture("adopt-abandoned-temps");
    await removePublicAuthorityFiles(directory);
    const state = join(directory, ".creatorcut");
    const uuid = "11111111-2222-4333-8444-555555555555";
    const tempPaths = [
      join(state, `project.json.999999.${uuid}.tmp`),
      join(state, `storage-authority.json.999999.${uuid}.tmp`),
      join(state, `storage-mutations.jsonl.999999.${uuid}.tmp`),
      join(state, `pending-authority-migration.json.999999.${uuid}.tmp`),
      join(state, `pending-public-mutation.json.999999.${uuid}.tmp`),
      join(state, "versions", `0.json.999999.${uuid}.tmp`),
      join(state, "tasks", `transcription.json.999999.${uuid}.tmp`),
      join(state, `.${uuid}.artifact.tmp`),
      join(state, "tasks", `.${uuid}.artifact.tmp`),
      join(state, "project.json.999999.tmp"),
      join(state, "versions", "0.json.999999.tmp"),
      join(state, "tasks", "transcription.json.999999.tmp"),
      join(state, "preview-confirmation.json.999999.tmp"),
    ];
    await Promise.all(
      tempPaths.map((path) => writeFile(path, "abandoned", { mode: 0o600 })),
    );

    await expect(
      adoptLegacyPublicProject(directory, { confirmLocal: true }),
    ).resolves.toMatchObject({ authority: "public-runtime" });
    for (const path of tempPaths) {
      await expect(readFile(path, "utf8")).resolves.toBe("abandoned");
    }
  });

  it("refuses a live-PID legacy atomic temp without deleting it or publishing adoption metadata", async () => {
    const directory = await publicFixture("adopt-live-legacy-temp");
    await removePublicAuthorityFiles(directory);
    const state = join(directory, ".creatorcut");
    const temp = join(state, `project.json.${process.pid}.tmp`);
    await writeFile(temp, "live-writer-temp", { mode: 0o600 });

    await expect(
      adoptLegacyPublicProject(directory, { confirmLocal: true }),
    ).rejects.toThrow(/atomic-write temp.*live|still running/iu);
    await expect(readFile(temp, "utf8")).resolves.toBe("live-writer-temp");
    await expect(
      access(join(state, "storage-authority.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(state, "storage-mutations.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not re-evaluate an ignored atomic temp PID after authority is published", async () => {
    const directory = await publicFixture("retained-live-pid-temp");
    const state = join(directory, ".creatorcut");
    const temp = join(state, `project.json.${process.pid}.tmp`);
    await writeFile(temp, "already-bound-retained-temp", { mode: 0o600 });

    await expect(openCreatorCutProject(directory)).resolves.toMatchObject({
      project: { revision: 0 },
    });
    await expect(
      commitLocalRevision(directory, {
        baseRevision: 0,
        nextTimeline: timeline(1),
        operationIds: ["retained-live-pid-temp-commit"],
      }),
    ).resolves.toMatchObject({ project: { revision: 1 } });
    await expect(readFile(temp, "utf8")).resolves.toBe(
      "already-bound-retained-temp",
    );
  });

  for (const kind of ["symlink", "hardlink", "unknown"] as const) {
    it(`retains and rejects an unsafe abandoned atomic temp: ${kind}`, async () => {
      const directory = await publicFixture(`adopt-unsafe-temp-${kind}`);
      await removePublicAuthorityFiles(directory);
      const state = join(directory, ".creatorcut");
      const uuid = "11111111-2222-4333-8444-555555555555";
      const external = join(dirname(directory), `${kind}-sentinel`);
      await writeFile(external, "preserve-me", { mode: 0o600 });
      const temp =
        kind === "unknown"
          ? join(state, `unknown.json.999999.${uuid}.tmp`)
          : join(state, `project.json.999999.${uuid}.tmp`);
      if (kind === "symlink") {
        await symlink(external, temp);
      } else if (kind === "hardlink") {
        await link(external, temp);
      } else {
        await writeFile(temp, "unknown", { mode: 0o600 });
      }

      await expect(
        adoptLegacyPublicProject(directory, { confirmLocal: true }),
      ).rejects.toThrow();
      await expect(readFile(external, "utf8")).resolves.toBe("preserve-me");
      await expect(access(temp)).resolves.toBeUndefined();
      await expect(
        access(join(state, "storage-authority.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  it("refuses to reset a multi-generation journal when its marker is missing", async () => {
    const directory = await publicFixture("adopt-journal-reset");
    await commitLocalRevision(directory, {
      baseRevision: 0,
      nextTimeline: timeline(1),
      operationIds: ["existing-public-mutation"],
    });
    await openCreatorCutProject(directory);
    const state = join(directory, ".creatorcut");
    const markerPath = join(state, "storage-authority.json");
    const journalPath = join(state, "storage-mutations.jsonl");
    const journal = await readFile(journalPath);
    await unlink(markerPath);

    await expect(
      adoptLegacyPublicProject(directory, { confirmLocal: true }),
    ).rejects.toThrow(/cannot be reset/u);
    await expect(readFile(journalPath)).resolves.toEqual(journal);
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  for (const [label, mutate] of [
    [
      "tampered digest",
      (journal: string) => {
        const entry = JSON.parse(journal) as Record<string, unknown>;
        entry.canonical_state_digest = `sha256:${"0".repeat(64)}`;
        return `${JSON.stringify(entry)}\n`;
      },
    ],
    [
      "unknown initial kind",
      (journal: string) => {
        const entry = JSON.parse(journal) as Record<string, unknown>;
        entry.mutation_kind = "project_create";
        return `${JSON.stringify(entry)}\n`;
      },
    ],
    ["torn JSON", (journal: string) => journal.slice(0, -8)],
  ] as const) {
    it(`leaves a ${label} orphan adoption journal unchanged`, async () => {
      const directory = await publicFixture(
        `adopt-orphan-${label.replaceAll(" ", "-")}`,
      );
      await removePublicAuthorityFiles(directory);
      const state = join(directory, ".creatorcut");
      const markerPath = join(state, "storage-authority.json");
      readCheckpoint.beforeRenamePath = join(
        await realpath(state),
        "storage-authority.json",
      );
      readCheckpoint.beforeRenameAction = async () => {
        throw new Error("Injected adoption marker publish failure");
      };
      await expect(
        adoptLegacyPublicProject(directory, { confirmLocal: true }),
      ).rejects.toThrow("Injected adoption marker publish failure");
      const journalPath = join(state, "storage-mutations.jsonl");
      const changed = mutate(await readFile(journalPath, "utf8"));
      await writeFile(journalPath, changed);

      await expect(
        adoptLegacyPublicProject(directory, { confirmLocal: true }),
      ).rejects.toThrow(/journal/u);
      await expect(readFile(journalPath, "utf8")).resolves.toBe(changed);
      await expect(access(markerPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  }

  for (const blocker of [
    "head.json",
    "m1-1-dogfood-report.json",
    "import-source.json",
    "studio.json",
    "preview-confirmation.json",
    "director-state.json",
    "pending-authority-migration.json",
    "pending-public-mutation.json",
    "pending-transaction.json",
    ".authority-migration",
    ".public-mutation",
  ]) {
    it(`rejects public adoption before writes when ${blocker} exists`, async () => {
      const directory = await publicFixture(
        `adopt-blocker-${blocker.replaceAll(/[^a-z0-9]/giu, "-")}`,
      );
      await removePublicAuthorityFiles(directory);
      const state = join(directory, ".creatorcut");
      const blockerPath = join(state, blocker);
      if (blocker.startsWith(".")) {
        await mkdir(blockerPath);
      } else {
        await writeFile(blockerPath, "{}\n");
      }

      await expect(
        adoptLegacyPublicProject(directory, { confirmLocal: true }),
      ).rejects.toThrow(/internal or pending storage/iu);
      await expect(
        access(join(state, "storage-authority.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        access(join(state, "storage-mutations.jsonl")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  it("serializes concurrent public creates and leaves one valid authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "creatorcut-public-create-"));
    const directory = join(root, "project.creatorcut");
    const attempts = await Promise.allSettled([
      createCreatorCutProject(directory, {
        project: project(0),
        timeline: timeline(0),
      }),
      createCreatorCutProject(directory, {
        project: project(0),
        timeline: timeline(0),
      }),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === "rejected"),
    ).toHaveLength(1);
    await expect(openCreatorCutProject(directory)).resolves.toMatchObject({
      authorityGeneration: 0,
      project: { project_id: "migration-fixture", revision: 0 },
    });
  });

  for (const [label, backup] of [
    ["root", resolve("/")],
    ["home", resolve(homedir())],
  ] as const) {
    it(`rejects the ${label} directory as a backup root`, async () => {
      const fixture = await legacyFixture(`backup-${label}`);
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: backup,
        }),
      ).rejects.toThrow(/backup path is unsafe/u);
    });
  }

  it("rejects project, .creatorcut, ancestors, and symlink backup roots", async () => {
    const fixture = await legacyFixture("backup-containment");
    const state = join(fixture.projectDirectory, ".creatorcut");
    for (const backupDirectory of [
      fixture.projectDirectory,
      state,
      dirname(fixture.projectDirectory),
      join(fixture.projectDirectory, "nested-backup"),
    ]) {
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory,
        }),
      ).rejects.toThrow(/backup path is unsafe/u);
    }
    const symlinkPath = join(dirname(fixture.projectDirectory), "backup-link");
    const target = await mkdtemp(join(tmpdir(), "creatorcut-backup-target-"));
    await symlink(target, symlinkPath);
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: symlinkPath,
      }),
    ).rejects.toThrow(/symbolic link/u);
  });

  it("does not trust persisted stage paths or migration IDs", async () => {
    const fixture = await legacyFixture("pending-path-attack");
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
        migrationId: "safe-migration",
        failureStage: "after_pending_write",
      }),
    ).rejects.toThrow("Injected failure");
    const pendingPath = join(
      fixture.projectDirectory,
      ".creatorcut",
      "pending-authority-migration.json",
    );
    const pending = JSON.parse(await readFile(pendingPath, "utf8"));
    for (const migrationId of ["/", "../escape", resolve(homedir())]) {
      await writeFile(
        pendingPath,
        JSON.stringify({ ...pending, migration_id: migrationId }),
      );
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
        }),
      ).rejects.toThrow(/migration ID|invalid/u);
    }
    await writeFile(
      pendingPath,
      JSON.stringify({ ...pending, stage_directory: resolve(homedir()) }),
    );
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
      }),
    ).rejects.toThrow(/unsupported or missing fields/u);
  });

  it("rejects a symlinked migration staging root without touching its target", async () => {
    const fixture = await legacyFixture("stage-symlink");
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
        migrationId: "stage-symlink",
        failureStage: "after_pending_write",
      }),
    ).rejects.toThrow("Injected failure");
    const outside = await mkdtemp(join(tmpdir(), "creatorcut-stage-outside-"));
    const sentinel = join(outside, "sentinel.txt");
    await writeFile(sentinel, "keep");
    await symlink(
      outside,
      join(fixture.projectDirectory, ".creatorcut", ".authority-migration"),
    );
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
      }),
    ).rejects.toThrow(/symbolic link|trusted directory/u);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep");
  });

  it("rejects an unbound migration staging sibling before creating authority state", async () => {
    const fixture = await legacyFixture("stage-unbound-sibling");
    const state = join(fixture.projectDirectory, ".creatorcut");
    const headPath = join(state, "head.json");
    const headBefore = await readFile(headPath);
    const stagingRoot = join(state, ".authority-migration");
    const staleStage = join(stagingRoot, "stale-private-stage");
    const privatePath = join(staleStage, "private-provider.json");
    const privateBytes = Buffer.from(
      '{"private_prompt":"must-not-cross-handoff"}',
    );
    await mkdir(staleStage, { recursive: true });
    await writeFile(privatePath, privateBytes);

    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
      }),
    ).rejects.toThrow(/unbound entry/u);
    expect(await readFile(headPath)).toEqual(headBefore);
    expect(await readFile(privatePath)).toEqual(privateBytes);
    await expect(
      access(join(state, "storage-authority.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(state, "pending-authority-migration.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a sibling injected beside the exact pending migration stage", async () => {
    const fixture = await legacyFixture("stage-pending-sibling");
    const state = join(fixture.projectDirectory, ".creatorcut");
    const migrationId = "stage-pending-sibling";
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
        migrationId,
        failureStage: "after_staging_write",
      }),
    ).rejects.toThrow("Injected failure: after_staging_write");
    const privatePath = join(
      state,
      ".authority-migration",
      "unbound-private.json",
    );
    const privateBytes = Buffer.from(
      '{"billing":"private","source_path":"/Users/secret.mov"}',
    );
    await writeFile(privatePath, privateBytes);

    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
      }),
    ).rejects.toThrow(/unbound entry/u);
    expect(await readFile(privatePath)).toEqual(privateBytes);
    await expect(access(join(state, "head.json"))).resolves.toBeUndefined();
    await expect(
      access(join(state, "pending-authority-migration.json")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(state, "storage-authority.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("durably removes the exact migration stage and empty root after handoff", async () => {
    const fixture = await legacyFixture("stage-root-cleanup");
    const state = join(fixture.projectDirectory, ".creatorcut");
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
        migrationId: "stage-root-cleanup",
      }),
    ).resolves.toMatchObject({ status: "migrated" });
    await expect(
      access(join(state, ".authority-migration")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      openCreatorCutProject(fixture.projectDirectory),
    ).resolves.toMatchObject({ authorityGeneration: 1 });
  });

  it("self-heals an exact committed stage on open after initial cleanup interruption", async () => {
    const fixture = await legacyFixture("stage-initial-cleanup-recovery");
    const state = join(fixture.projectDirectory, ".creatorcut");
    const migrationId = "stage-initial-cleanup-recovery";
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
        migrationId,
        failureStage: "after_initial_pending_remove_before_stage_cleanup",
      }),
    ).rejects.toThrow(
      "Injected failure: after_initial_pending_remove_before_stage_cleanup",
    );
    await expect(
      access(join(state, "pending-authority-migration.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(state, ".authority-migration", migrationId)),
    ).resolves.toBeUndefined();

    const sibling = join(
      state,
      ".authority-migration",
      "unbound-private-sibling",
    );
    const siblingBytes = Buffer.from('{"private_prompt":"must-remain"}');
    await writeFile(sibling, siblingBytes);
    await expect(
      openCreatorCutProject(fixture.projectDirectory),
    ).rejects.toThrow(/unbound entry/u);
    expect(await readFile(sibling)).toEqual(siblingBytes);
    await rm(sibling);

    await expect(
      openCreatorCutProject(fixture.projectDirectory),
    ).resolves.toMatchObject({ authorityGeneration: 1 });
    await expect(
      access(join(state, ".authority-migration")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("self-heals an exact committed stage on migrate retry after recovery cleanup interruption", async () => {
    const fixture = await legacyFixture("stage-retry-cleanup-recovery");
    const state = join(fixture.projectDirectory, ".creatorcut");
    const migrationId = "stage-retry-cleanup-recovery";
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
        migrationId,
        failureStage: "after_authority_marker",
      }),
    ).rejects.toThrow("Injected failure: after_authority_marker");
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
        migrationId,
        failureStage: "after_recovery_pending_remove_before_stage_cleanup",
      }),
    ).rejects.toThrow(
      "Injected failure: after_recovery_pending_remove_before_stage_cleanup",
    );
    await expect(
      access(join(state, "pending-authority-migration.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(state, ".authority-migration", migrationId)),
    ).resolves.toBeUndefined();

    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
        migrationId,
      }),
    ).resolves.toMatchObject({
      status: "already_migrated",
      authority: "public-runtime",
    });
    await expect(
      access(join(state, ".authority-migration")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves and rejects a same-id committed stage with rebound canonical bytes", async () => {
    const fixture = await legacyFixture("stage-committed-canonical-tamper");
    const state = join(fixture.projectDirectory, ".creatorcut");
    const migrationId = "stage-committed-canonical-tamper";
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
        migrationId,
        failureStage: "after_initial_pending_remove_before_stage_cleanup",
      }),
    ).rejects.toThrow(
      "Injected failure: after_initial_pending_remove_before_stage_cleanup",
    );
    const stage = join(state, ".authority-migration", migrationId);
    const projectPath = join(stage, "canonical", "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    const changedName = "rebound-committed-stage";
    await writeFile(
      projectPath,
      JSON.stringify({ ...project, name: changedName }),
    );
    const currentVersionPath = join(
      stage,
      "canonical",
      "versions",
      `${project.revision}.json`,
    );
    const currentVersion = JSON.parse(
      await readFile(currentVersionPath, "utf8"),
    );
    await writeFile(
      currentVersionPath,
      JSON.stringify({
        ...currentVersion,
        project: { ...currentVersion.project, name: changedName },
      }),
    );
    await rebindStageManifest(stage);
    const tamperedProject = await readFile(projectPath);

    await expect(
      openCreatorCutProject(fixture.projectDirectory),
    ).rejects.toThrow(/committed stage|stage digest|authority stage/u);
    expect(await readFile(projectPath)).toEqual(tamperedProject);
    await expect(
      access(join(state, "storage-authority.json")),
    ).resolves.toBeUndefined();
  });

  it("preserves and rejects private bytes injected into an exact committed stage", async () => {
    const fixture = await legacyFixture("stage-committed-private-extra");
    const state = join(fixture.projectDirectory, ".creatorcut");
    const migrationId = "stage-committed-private-extra";
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
        migrationId,
        failureStage: "after_initial_pending_remove_before_stage_cleanup",
      }),
    ).rejects.toThrow(
      "Injected failure: after_initial_pending_remove_before_stage_cleanup",
    );
    const privatePath = join(
      state,
      ".authority-migration",
      migrationId,
      "private-provider.json",
    );
    const privateBytes = Buffer.from(
      '{"private_prompt":"must-not-be-silently-deleted"}',
    );
    await writeFile(privatePath, privateBytes);

    await expect(
      openCreatorCutProject(fixture.projectDirectory),
    ).rejects.toThrow(/stage.*canonical|unsupported|unbound/u);
    expect(await readFile(privatePath)).toEqual(privateBytes);
  });

  it("fails closed on public open when a symlink sibling appears in the migration root", async () => {
    const fixture = await legacyFixture("stage-public-symlink-sibling");
    const state = join(fixture.projectDirectory, ".creatorcut");
    await migrateLegacyInternalProject(fixture.projectDirectory, {
      backupDirectory: fixture.backupDirectory,
      migrationId: "stage-public-symlink-sibling",
    });
    const outside = await mkdtemp(
      join(tmpdir(), "creatorcut-stage-symlink-outside-"),
    );
    const sentinel = join(outside, "sentinel.txt");
    const sentinelBytes = Buffer.from("outside-stage-bytes-must-survive");
    await writeFile(sentinel, sentinelBytes);
    const stagingRoot = join(state, ".authority-migration");
    await mkdir(stagingRoot);
    await symlink(outside, join(stagingRoot, "stale-private-stage"));

    await expect(
      openCreatorCutProject(fixture.projectDirectory),
    ).rejects.toThrow(/unbound entry/u);
    expect(await readFile(sentinel)).toEqual(sentinelBytes);
  });

  for (const [name, contents] of [
    ["cache.mp4", Buffer.from("video")],
    ["cache.wav", Buffer.from("audio")],
    ["cache.png", Buffer.from("image")],
    ["unknown.json", Buffer.from("{}")],
    ["oversize.json", Buffer.alloc(16 * 1024 * 1024 + 1, 0x20)],
  ] as const) {
    it(`fails metadata-only backup closed for ${name}`, async () => {
      const fixture = await legacyFixture(`backup-allowlist-${name}`);
      await writeFile(
        join(fixture.projectDirectory, ".creatorcut", name),
        contents,
      );
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
        }),
      ).rejects.toThrow(/non-metadata|small regular file|binary/u);
      expect(await exists(fixture.backupDirectory)).toBe(false);
    });
  }

  it("rejects metadata symlinks before creating a backup", async () => {
    const fixture = await legacyFixture("backup-metadata-symlink");
    const outside = join(dirname(fixture.projectDirectory), "outside.json");
    await writeFile(outside, "{}");
    await symlink(
      outside,
      join(fixture.projectDirectory, ".creatorcut", "director-state.json"),
    );
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
      }),
    ).rejects.toThrow(/symbolic link/u);
    expect(await exists(fixture.backupDirectory)).toBe(false);
  });

  it("rejects a metadata file replaced by a symlink between enumeration and open", async () => {
    const fixture = await legacyFixture("backup-metadata-symlink-race");
    const state = await realpath(join(fixture.projectDirectory, ".creatorcut"));
    const target = join(state, "fine-cut-card-chain.json");
    const outside = join(dirname(fixture.projectDirectory), "outside.json");
    const outsideBytes = `${JSON.stringify({ private_prompt: "never-copy" })}\n`;
    await writeFile(outside, outsideBytes);
    readCheckpoint.beforeOpenPath = target;
    readCheckpoint.beforeOpenAction = async () => {
      await rm(target);
      await symlink(outside, target);
    };
    try {
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
        }),
      ).rejects.toThrow();
      expect(await exists(fixture.backupDirectory)).toBe(false);
      await expect(readFile(outside, "utf8")).resolves.toBe(outsideBytes);
    } finally {
      readCheckpoint.beforeOpenPath = "";
      readCheckpoint.beforeOpenAction = undefined;
    }
  });

  it("rejects a backup metadata ancestor replaced after parent validation", async () => {
    const fixture = await legacyFixture("backup-ancestor-symlink-race");
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
        failureStage: "after_pending_write",
      }),
    ).rejects.toThrow("Injected failure: after_pending_write");
    const manifest = JSON.parse(
      await readFile(join(fixture.backupDirectory, "manifest.json"), "utf8"),
    );
    const firstRelativePath = manifest.files[0].relative_path as string;
    const metadata = join(fixture.backupDirectory, "metadata");
    const movedMetadata = join(
      dirname(fixture.backupDirectory),
      "outside-backup-metadata",
    );
    const firstPath = join(metadata, ...firstRelativePath.split("/"));
    const firstBytes = await readFile(firstPath);
    readCheckpoint.beforeOpenPath = await realpath(firstPath);
    readCheckpoint.beforeOpenAction = async () => {
      await rename(metadata, movedMetadata);
      await symlink(movedMetadata, metadata);
    };
    try {
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
        }),
      ).rejects.toThrow(/symbolic link|trusted|changed|identity/u);
      expect(
        await readFile(join(movedMetadata, ...firstRelativePath.split("/"))),
      ).toEqual(firstBytes);
      await expect(
        access(
          join(
            fixture.projectDirectory,
            ".creatorcut",
            "storage-authority.json",
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      readCheckpoint.beforeOpenPath = "";
      readCheckpoint.beforeOpenAction = undefined;
    }
  });

  it("rejects an ancestor ABA replacement before reading outside metadata", async () => {
    const fixture = await legacyFixture("backup-ancestor-aba");
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
        failureStage: "after_pending_write",
      }),
    ).rejects.toThrow("Injected failure: after_pending_write");
    const manifest = JSON.parse(
      await readFile(join(fixture.backupDirectory, "manifest.json"), "utf8"),
    );
    const relativePath = manifest.files[0].relative_path as string;
    const metadata = join(fixture.backupDirectory, "metadata");
    const movedMetadata = join(
      dirname(fixture.backupDirectory),
      "aba-original-metadata",
    );
    const outside = join(dirname(fixture.backupDirectory), "aba-outside");
    const target = join(metadata, ...relativePath.split("/"));
    const outsideTarget = join(outside, ...relativePath.split("/"));
    await mkdir(dirname(outsideTarget), { recursive: true });
    const outsideBytes = Buffer.from('{"private_prompt":"must-not-read"}');
    await writeFile(outsideTarget, outsideBytes);
    let outsideWasRead = false;
    readCheckpoint.beforeOpenPath = await realpath(target);
    readCheckpoint.beforeOpenAction = async () => {
      await rename(metadata, movedMetadata);
      await symlink(outside, metadata);
    };
    readCheckpoint.afterOpenPath = readCheckpoint.beforeOpenPath;
    readCheckpoint.afterOpenAction = async () => {
      await unlink(metadata);
      await rename(movedMetadata, metadata);
    };
    readCheckpoint.path = readCheckpoint.beforeOpenPath;
    readCheckpoint.count = 0;
    readCheckpoint.triggerCount = 1;
    readCheckpoint.action = async () => {
      outsideWasRead = true;
    };
    try {
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
        }),
      ).rejects.toThrow(/identity|changed|trusted/u);
      expect(outsideWasRead).toBe(false);
      expect(await readFile(outsideTarget)).toEqual(outsideBytes);
    } finally {
      readCheckpoint.beforeOpenPath = "";
      readCheckpoint.beforeOpenAction = undefined;
      readCheckpoint.afterOpenPath = "";
      readCheckpoint.afterOpenAction = undefined;
      readCheckpoint.path = "";
      readCheckpoint.count = 0;
      readCheckpoint.triggerCount = 0;
      readCheckpoint.action = undefined;
    }
  });

  it("revalidates the pending-bound backup immediately before destructive installation", async () => {
    const fixture = await legacyFixture("backup-final-install-binding");
    const state = join(fixture.projectDirectory, ".creatorcut");
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
        migrationId: "backup-final-install-binding",
        failureStage: "after_pending_write",
      }),
    ).rejects.toThrow("Injected failure: after_pending_write");
    const publishedManifest = JSON.parse(
      await readFile(join(fixture.backupDirectory, "manifest.json"), "utf8"),
    );
    const lastRelativePath = publishedManifest.files.at(-1)!
      .relative_path as string;
    readCheckpoint.path = await realpath(
      join(fixture.backupDirectory, "metadata", ...lastRelativePath.split("/")),
    );
    readCheckpoint.count = 0;
    readCheckpoint.triggerCount = 3;
    readCheckpoint.action = async () => {
      await replaceBackupFileAndRebind(
        fixture.backupDirectory,
        "head.json",
        (value) => {
          const head = structuredClone(value) as any;
          head.snapshot.project.name = "unbound-final-backup";
          return head;
        },
      );
    };
    try {
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
        }),
      ).rejects.toThrow(/backup.*binding|exact backup|backup changed/u);
      await expect(access(join(state, "head.json"))).resolves.toBeUndefined();
      await expect(
        access(join(state, "storage-authority.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(readCheckpoint.count).toBeGreaterThanOrEqual(3);
    } finally {
      readCheckpoint.path = "";
      readCheckpoint.count = 0;
      readCheckpoint.triggerCount = 0;
      readCheckpoint.action = undefined;
    }
  });

  it("preserves exact rollback source when backup changes after final validation but before legacy removal", async () => {
    const fixture = await legacyFixture("backup-final-delete-window");
    const state = join(fixture.projectDirectory, ".creatorcut");
    const headPath = join(state, "head.json");
    const headBefore = await readFile(headPath);
    readCheckpoint.beforeRmPath = headPath;
    readCheckpoint.beforeRmAction = async () => {
      await replaceBackupFileAndRebind(
        fixture.backupDirectory,
        "head.json",
        (value) => {
          const head = structuredClone(value) as any;
          head.snapshot.project.name = "late-unbound-backup";
          return head;
        },
      );
    };
    try {
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
          migrationId: "backup-final-delete-window",
        }),
      ).rejects.toThrow(/backup.*binding|backup changed/u);
      expect(await readFile(headPath)).toEqual(headBefore);
      await expect(
        access(join(state, "storage-authority.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      readCheckpoint.beforeRmPath = "";
      readCheckpoint.beforeRmAction = undefined;
    }
  });

  it("recovers a crashed legacy deletion from the immutable staged rollback source", async () => {
    const fixture = await legacyFixture("staged-rollback-source-crash");
    const state = join(fixture.projectDirectory, ".creatorcut");
    const headPath = join(state, "head.json");
    const headBefore = await readFile(headPath);
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
        migrationId: "staged-rollback-source-crash",
        failureStage: "after_legacy_head_remove",
      }),
    ).rejects.toThrow("Injected failure: after_legacy_head_remove");
    await expect(access(headPath)).rejects.toMatchObject({ code: "ENOENT" });

    await replaceBackupFileAndRebind(
      fixture.backupDirectory,
      "head.json",
      (value) => {
        const head = structuredClone(value) as any;
        head.snapshot.project.name = "tampered-external-backup";
        return head;
      },
    );
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
      }),
    ).rejects.toThrow(/backup.*changed|backup.*binding/u);
    expect(await readFile(headPath)).toEqual(headBefore);

    await expect(
      rollbackStorageAuthorityMigration(
        fixture.projectDirectory,
        fixture.backupDirectory,
      ),
    ).resolves.toMatchObject({ authority: "internal-project-store" });
    expect(await readFile(headPath)).toEqual(headBefore);
    await expect(
      access(join(state, ".authority-migration")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a fine-cut preview symlink without reading outside the project", async () => {
    const fixture = await legacyFixture("preview-symlink");
    const preview = join(
      fixture.projectDirectory,
      "previews",
      "approved-preview.mp4",
    );
    const outside = join(dirname(fixture.projectDirectory), "private.mp4");
    const outsideBytes = Buffer.from("outside-private-preview");
    await writeFile(outside, outsideBytes);
    await rm(preview);
    await symlink(outside, preview);
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
      }),
    ).rejects.toThrow();
    await expect(readFile(outside)).resolves.toEqual(outsideBytes);
    await expect(
      access(
        join(fixture.projectDirectory, ".creatorcut", "storage-authority.json"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  for (const [label, unsafePath] of [
    ["backslash traversal", "previews\\..\\outside.mp4"],
    ["drive path", "C:\\outside.mp4"],
    ["UNC path", "\\\\server\\share\\outside.mp4"],
    ["alternate data stream", "previews/approved-preview.mp4:secret"],
    ["parent traversal", "previews/../outside.mp4"],
    ["NUL", "previews/approved\0preview.mp4"],
  ] as const) {
    it(`rejects unsafe fine-cut preview ${label}`, async () => {
      const fixture = await legacyFixture(`preview-path-${label}`);
      const chainPath = join(
        fixture.projectDirectory,
        ".creatorcut",
        "fine-cut-card-chain.json",
      );
      const chain = JSON.parse(await readFile(chainPath, "utf8"));
      await writeFile(
        chainPath,
        JSON.stringify({ ...chain, preview_relative_path: unsafePath }),
      );
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
        }),
      ).rejects.toThrow(/Unsafe metadata path|preview namespace/u);
    });
  }

  for (const [label, contents, expected] of [
    ["binary", Buffer.from([0, 1, 2]), /binary data/u],
    [
      "oversize",
      Buffer.alloc(16 * 1024 * 1024 + 1, 0x20),
      /small regular file/u,
    ],
  ] as const) {
    it(`rejects allowed metadata containing ${label} content`, async () => {
      const fixture = await legacyFixture(`backup-known-${label}`);
      await writeFile(
        join(fixture.projectDirectory, ".creatorcut", "director-state.json"),
        contents,
      );
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
        }),
      ).rejects.toThrow(expected);
      expect(await exists(fixture.backupDirectory)).toBe(false);
    });
  }

  it("rejects a same-revision backup after any source metadata byte changes", async () => {
    const fixture = await legacyFixture("backup-byte-binding");
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
        failureStage: "after_pending_write",
      }),
    ).rejects.toThrow("Injected failure");
    await rm(
      join(
        fixture.projectDirectory,
        ".creatorcut",
        "pending-authority-migration.json",
      ),
    );
    const chainPath = join(
      fixture.projectDirectory,
      ".creatorcut",
      "fine-cut-card-chain.json",
    );
    const chain = JSON.parse(await readFile(chainPath, "utf8"));
    await writeFile(
      chainPath,
      `${JSON.stringify({ ...chain, updated_at: "2026-08-09T00:00:04.000Z" })}\n`,
    );
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
      }),
    ).rejects.toThrow(/does not match current metadata bytes/u);
  });

  for (const failureStage of [
    "after_pending_write",
    "after_staging_write",
  ] as const) {
    it(`rejects source mutation when re-entering ${failureStage}`, async () => {
      const fixture = await legacyFixture(`pending-source-${failureStage}`);
      const state = join(fixture.projectDirectory, ".creatorcut");
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
          migrationId: `pending-source-${failureStage}`,
          failureStage,
        }),
      ).rejects.toThrow(`Injected failure: ${failureStage}`);
      const chainPath = join(state, "fine-cut-card-chain.json");
      const chain = JSON.parse(await readFile(chainPath, "utf8"));
      await writeFile(
        chainPath,
        `${JSON.stringify({
          ...chain,
          updated_at: "2026-08-09T00:00:05.000Z",
        })}\n`,
      );
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
        }),
      ).rejects.toThrow(
        /Source metadata changed after migration became pending/u,
      );
      await expect(access(join(state, "head.json"))).resolves.toBeUndefined();
      await expect(
        access(join(state, "pending-authority-migration.json")),
      ).resolves.toBeUndefined();
    });

    it(`rejects backup mutation when re-entering ${failureStage}`, async () => {
      const fixture = await legacyFixture(`pending-backup-${failureStage}`);
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
          migrationId: `pending-backup-${failureStage}`,
          failureStage,
        }),
      ).rejects.toThrow(`Injected failure: ${failureStage}`);
      const backupChain = join(
        fixture.backupDirectory,
        "metadata",
        "fine-cut-card-chain.json",
      );
      await writeFile(backupChain, JSON.stringify({ tampered: true }));
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
        }),
      ).rejects.toThrow(/Metadata backup digest mismatch/u);
      await expect(
        access(
          join(
            fixture.projectDirectory,
            ".creatorcut",
            "pending-authority-migration.json",
          ),
        ),
      ).resolves.toBeUndefined();
    });
  }

  for (const failureStage of [
    "after_versions_replace",
    "after_mirrors_replace",
  ] as const) {
    it(`rejects unbound bytes in a partial install after ${failureStage}`, async () => {
      const fixture = await legacyFixture(`partial-install-${failureStage}`);
      const state = join(fixture.projectDirectory, ".creatorcut");
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
          migrationId: `partial-install-${failureStage}`,
          failureStage,
        }),
      ).rejects.toThrow(`Injected failure: ${failureStage}`);
      const chainPath = join(state, "fine-cut-card-chain.json");
      const chain = JSON.parse(await readFile(chainPath, "utf8"));
      await writeFile(
        chainPath,
        `${JSON.stringify({ ...chain, updated_at: "tampered" })}\n`,
      );
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
        }),
      ).rejects.toThrow(/Partial migration contains unbound metadata bytes/u);
      await expect(access(join(state, "head.json"))).resolves.toBeUndefined();
    });
  }

  it.each([
    ["head.json", "after_legacy_head_remove"],
    ["m1-1-dogfood-report.json", "after_legacy_report_remove"],
    ["import-source.json", "after_legacy_import_remove"],
    ["studio.json", "after_legacy_studio_remove"],
    ["director-consent.json", "after_legacy_director_consent_remove"],
    ["director-state.json", "after_legacy_director_state_remove"],
    ["preview-confirmation.json", "after_legacy_preview_confirmation_remove"],
  ] as const)(
    "recovers after deleting an actual legacy artifact %s",
    async (relativePath, failureStage) => {
      const fixture = await legacyFixture(`legacy-remove-${failureStage}`);
      const state = join(fixture.projectDirectory, ".creatorcut");
      const artifactPath = join(state, relativePath);
      if (relativePath !== "head.json") {
        await writeFile(
          artifactPath,
          `${JSON.stringify({
            schema_version: "legacy-private-fixture/1.0",
            private_prompt: "/Users/secret/private prompt",
          })}\n`,
        );
      }
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
          migrationId: `legacy-remove-${failureStage}`,
          failureStage,
        }),
      ).rejects.toThrow(`Injected failure: ${failureStage}`);
      await expect(access(artifactPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        access(join(state, "storage-authority.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const recovered = await migrateLegacyInternalProject(
        fixture.projectDirectory,
        { backupDirectory: fixture.backupDirectory },
      );
      expect(recovered.status).toBe("migrated");
      await expect(access(artifactPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        await readFile(join(state, "storage-authority.json"), "utf8"),
      ).not.toContain("private_prompt");
    },
    15_000,
  );

  it("fails closed when the initial handoff journal is changed before marker publication", async () => {
    const fixture = await legacyFixture("initial-journal-tamper");
    const state = join(fixture.projectDirectory, ".creatorcut");
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
        migrationId: "initial-journal-tamper",
        failureStage: "after_initial_journal",
      }),
    ).rejects.toThrow("Injected failure: after_initial_journal");
    const journalPath = join(state, "storage-mutations.jsonl");
    const [journalEntry] = (await readFile(journalPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    await writeFile(
      journalPath,
      `${JSON.stringify({
        ...journalEntry,
        migration_id: "attacker-journal",
      })}\n`,
    );

    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
      }),
    ).rejects.toThrow(/unbound metadata bytes/u);
    await expect(
      access(join(state, "storage-authority.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(state, "pending-authority-migration.json")),
    ).resolves.toBeUndefined();
  });

  for (const mutation of ["bytes", "file-set"] as const) {
    it(`aborts backup when the source ${mutation} changes during snapshot copy`, async () => {
      const fixture = await legacyFixture(`backup-toctou-${mutation}`);
      const state = join(fixture.projectDirectory, ".creatorcut");
      readCheckpoint.afterOpenPath = await realpath(join(state, "head.json"));
      readCheckpoint.afterOpenAction = async () => {
        if (mutation === "bytes") {
          const chainPath = join(state, "fine-cut-card-chain.json");
          const chain = JSON.parse(await readFile(chainPath, "utf8"));
          await writeFile(
            chainPath,
            `${JSON.stringify({
              ...chain,
              updated_at: "2026-08-09T00:00:04.000Z",
            })}\n`,
          );
        } else {
          await writeFile(
            join(state, "director-state.json"),
            `${JSON.stringify({
              schema_version: "creatorcut-public-director-state/1.0",
              project_id: "migration-fixture",
            })}\n`,
          );
        }
      };
      try {
        await expect(
          migrateLegacyInternalProject(fixture.projectDirectory, {
            backupDirectory: fixture.backupDirectory,
          }),
        ).rejects.toThrow(
          /Source metadata changed while creating migration backup/u,
        );
        expect(await exists(fixture.backupDirectory)).toBe(false);
        expect(readCheckpoint.afterOpenAction).toBeUndefined();
      } finally {
        readCheckpoint.afterOpenPath = "";
        readCheckpoint.afterOpenAction = undefined;
      }
    });
  }

  it("syncs nested backup and mutation snapshot directories from leaves to parents", async () => {
    const fixture = await legacyFixture("directory-sync-order");
    readCheckpoint.recordSyncs = true;
    readCheckpoint.syncedPaths = [];
    readCheckpoint.recordDurabilityEvents = true;
    readCheckpoint.durabilityEvents = [];
    try {
      await migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
      });
      const backupVersions = readCheckpoint.syncedPaths.findIndex((path) =>
        path.endsWith(join("metadata", "versions")),
      );
      const backupMetadata = readCheckpoint.syncedPaths.findIndex(
        (path, index) => index > backupVersions && path.endsWith("metadata"),
      );
      expect(backupVersions).toBeGreaterThanOrEqual(0);
      expect(backupMetadata).toBeGreaterThan(backupVersions);

      const migrationEvents = [...readCheckpoint.durabilityEvents];
      const nestedStageMkdir = migrationEvents.findIndex(
        (event) =>
          event.startsWith("mkdir:") &&
          event.endsWith(join("canonical", "versions")),
      );
      expect(nestedStageMkdir).toBeGreaterThanOrEqual(0);
      const nestedStagePath = migrationEvents[nestedStageMkdir]!.slice(
        "mkdir:".length,
      );
      expect(migrationEvents[nestedStageMkdir + 1]).toBe(
        `sync:${dirname(nestedStagePath)}`,
      );
      expect(migrationEvents[nestedStageMkdir + 2]).toBe(
        `sync:${nestedStagePath}`,
      );
      const backupRename = migrationEvents.findIndex(
        (event) =>
          event.startsWith("rename:") && event.endsWith("metadata-backup"),
      );
      expect(backupRename).toBeGreaterThanOrEqual(0);
      expect(migrationEvents[backupRename + 1]).toMatch(/sync:/u);
      const stageChildDelete = migrationEvents.findIndex((event) => {
        const removedPath = event.startsWith("rm:")
          ? event.slice("rm:".length)
          : "";
        return dirname(removedPath).endsWith(".authority-migration");
      });
      expect(stageChildDelete).toBeGreaterThanOrEqual(0);
      const stageChildPath = migrationEvents[stageChildDelete]!.slice(
        "rm:".length,
      );
      const stageParentSync = migrationEvents.findIndex(
        (event, index) =>
          index > stageChildDelete &&
          event === `sync:${dirname(stageChildPath)}`,
      );
      const stagingRootDelete = migrationEvents.findIndex(
        (event, index) =>
          index > stageParentSync &&
          event.startsWith("rm:") &&
          event.endsWith(".authority-migration"),
      );
      expect(stagingRootDelete).toBeGreaterThan(stageParentSync);
      const stagingRootPath = migrationEvents[stagingRootDelete]!.slice(
        "rm:".length,
      );
      const stagingRootParentSync = migrationEvents.findIndex(
        (event, index) =>
          index > stagingRootDelete &&
          event === `sync:${dirname(stagingRootPath)}`,
      );
      expect(stageParentSync).toBeGreaterThan(stageChildDelete);
      expect(stagingRootParentSync).toBeGreaterThan(stagingRootDelete);

      readCheckpoint.syncedPaths = [];
      readCheckpoint.durabilityEvents = [];
      await withPublicStorageMutation(
        join(fixture.projectDirectory, ".creatorcut"),
        "sync_order_test",
        async (marker) => ({
          value: undefined,
          currentRevision: marker.current_revision,
        }),
      );
      const beforeVersions = readCheckpoint.syncedPaths.findIndex((path) =>
        path.endsWith(join("before", "versions")),
      );
      const before = readCheckpoint.syncedPaths.findIndex(
        (path, index) => index > beforeVersions && path.endsWith("before"),
      );
      expect(beforeVersions).toBeGreaterThanOrEqual(0);
      expect(before).toBeGreaterThan(beforeVersions);
      const mutationEvents = readCheckpoint.durabilityEvents;
      const nestedSnapshotMkdir = mutationEvents.findIndex(
        (event) =>
          event.startsWith("mkdir:") &&
          event.endsWith(join("before", "versions")),
      );
      expect(nestedSnapshotMkdir).toBeGreaterThanOrEqual(0);
      const nestedSnapshotPath = mutationEvents[nestedSnapshotMkdir]!.slice(
        "mkdir:".length,
      );
      const snapshotRoot = dirname(nestedSnapshotPath);
      expect(mutationEvents[nestedSnapshotMkdir + 1]).toBe(
        `sync:${snapshotRoot}`,
      );
      expect(mutationEvents[nestedSnapshotMkdir + 2]).toBe(
        `sync:${nestedSnapshotPath}`,
      );
      const snapshotTreeSync = mutationEvents.findIndex(
        (event, index) =>
          index > nestedSnapshotMkdir + 2 && event === `sync:${snapshotRoot}`,
      );
      const pendingRename = mutationEvents.findIndex(
        (event) =>
          event.startsWith("rename:") &&
          event.endsWith("pending-public-mutation.json"),
      );
      expect(snapshotTreeSync).toBeGreaterThanOrEqual(0);
      expect(pendingRename).toBeGreaterThan(snapshotTreeSync);
      expect(mutationEvents[pendingRename + 1]).toMatch(
        /sync:.*\.creatorcut$/u,
      );
      const mutationStageDelete = mutationEvents.findLastIndex(
        (event) =>
          event.startsWith("rm:") && event.includes(".public-mutation"),
      );
      expect(mutationStageDelete).toBeGreaterThanOrEqual(0);
      const mutationStagePath = mutationEvents[mutationStageDelete]!.slice(
        "rm:".length,
      );
      expect(mutationEvents[mutationStageDelete + 1]).toBe(
        `sync:${dirname(mutationStagePath)}`,
      );
    } finally {
      readCheckpoint.recordSyncs = false;
      readCheckpoint.syncedPaths = [];
      readCheckpoint.recordDurabilityEvents = false;
      readCheckpoint.durabilityEvents = [];
    }
  });

  it("cleans a temporary backup after a nested directory sync failure", async () => {
    const fixture = await legacyFixture("directory-sync-failure");
    readCheckpoint.failSyncSuffix = join("metadata", "versions");
    try {
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
        }),
      ).rejects.toThrow("Injected directory sync failure");
      expect(await exists(fixture.backupDirectory)).toBe(false);
      expect(
        (await readdir(dirname(fixture.backupDirectory))).some((name) =>
          name.startsWith("metadata-backup.tmp-"),
        ),
      ).toBe(false);
    } finally {
      readCheckpoint.failSyncSuffix = "";
    }
  });

  it("does not publish a public mutation pending record before its stage directories are durable", async () => {
    const projectDirectory = await publicFixture("mutation-stage-durability");
    const state = join(projectDirectory, ".creatorcut");
    const before = await openCreatorCutProject(projectDirectory);
    let operationCalls = 0;
    readCheckpoint.failSyncSuffix = ".public-mutation";
    try {
      await expect(
        withPublicStorageMutation(state, "durability_probe", async (marker) => {
          operationCalls += 1;
          return {
            value: undefined,
            currentRevision: marker.current_revision,
          };
        }),
      ).rejects.toThrow("Injected directory sync failure");
      expect(operationCalls).toBe(0);
      await expect(
        access(join(state, "pending-public-mutation.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const after = await openCreatorCutProject(projectDirectory);
      expect(after.authorityGeneration).toBe(before.authorityGeneration);
      expect(after.project.revision).toBe(before.project.revision);
    } finally {
      readCheckpoint.failSyncSuffix = "";
    }
  });

  it("excludes lock recovery infrastructure across migrate, open, and rollback", async () => {
    const fixture = await legacyFixture("lock-recovery-inventory");
    const state = join(fixture.projectDirectory, ".creatorcut");
    await writeFile(
      join(state, "project.lock"),
      JSON.stringify({
        pid: 2_147_483_647,
        created_at: "2026-08-09T00:00:00.000Z",
      }),
    );
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
        migrationId: "lock-recovery-inventory",
      }),
    ).resolves.toMatchObject({ status: "migrated" });
    await expect(
      readdir(join(state, "project.lock.recovery")),
    ).resolves.toEqual([".creating"]);
    await expect(
      readdir(join(state, "project.lock.recovery", ".creating")),
    ).resolves.toEqual(["current-mutex.sqlite"]);
    await expect(
      openCreatorCutProject(fixture.projectDirectory),
    ).resolves.toMatchObject({ project: { revision: 3 } });
    await expect(
      rollbackStorageAuthorityMigration(
        fixture.projectDirectory,
        fixture.backupDirectory,
      ),
    ).resolves.toMatchObject({ status: "rolled_back" });
    await expect(access(join(state, "head.json"))).resolves.toBeUndefined();
    await expect(
      readdir(join(state, "project.lock.recovery")),
    ).resolves.toEqual([".creating"]);
    await expect(
      readdir(join(state, "project.lock.recovery", ".creating")),
    ).resolves.toEqual(["current-mutex.sqlite"]);
  });

  it("requires trusted internal pending transaction recovery before migration", async () => {
    const fixture = await legacyFixture("internal-pending");
    const pending = join(
      fixture.projectDirectory,
      ".creatorcut",
      "pending-transaction.json",
    );
    await writeFile(pending, JSON.stringify({ schema_version: "1.0-alpha" }));
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
      }),
    ).rejects.toThrow(/internal transaction recovery must complete/u);
    await rm(pending);
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
      }),
    ).resolves.toMatchObject({ status: "migrated" });
  });
});

describe("public mutation WAL and authority binding", () => {
  it("accepts a standard transcript written at an adopted revision and remains writable", async () => {
    const fixture = await legacyFixture("adopted-standard-transcript");
    await migrateLegacyInternalProject(fixture.projectDirectory, {
      backupDirectory: fixture.backupDirectory,
    });
    const opened = await openCreatorCutProject(fixture.projectDirectory);
    const standardTranscript = structuredClone(opened.transcript);
    delete standardTranscript.migration_status;
    delete standardTranscript.source_revision;

    const replaced = await replaceLocalTranscript(
      fixture.projectDirectory,
      standardTranscript,
    );
    expect(replaced.transcript.migration_status).toBeUndefined();
    await expect(
      openCreatorCutProject(fixture.projectDirectory),
    ).resolves.toMatchObject({
      transcript: { revision: opened.project.revision },
    });
    await expect(
      writeLocalArtifact(fixture.projectDirectory, "tasks/import.json", {
        schema_version: "creatorcut-import-task/1.0",
        state: "completed",
        source_asset_id: "asset-post-transcript",
        source_sha256: "a".repeat(64),
        proxy_relative_path: "proxies/post-transcript.mp4",
        proxy_sha256: "b".repeat(64),
        completed_at: "2026-08-09T00:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
    const reopened = await openCreatorCutProject(fixture.projectDirectory);
    expect(reopened.transcript).not.toHaveProperty("migration_status");
  });

  it("accepts a standard edit brief on the first public revision after handoff", async () => {
    const fixture = await legacyFixture("post-handoff-standard-brief");
    await migrateLegacyInternalProject(fixture.projectDirectory, {
      backupDirectory: fixture.backupDirectory,
    });
    const opened = await openCreatorCutProject(fixture.projectDirectory);
    const committed = await commitLocalRevision(fixture.projectDirectory, {
      baseRevision: opened.project.revision,
      nextTimeline: structuredClone(opened.timeline),
      nextEditBrief: {
        schema_version: "1.0",
        brief_id: "brief-public-after-handoff",
        project_id: opened.project.project_id,
        base_revision: opened.project.revision,
        audio_mode: "original",
        caption_style_id: "caption_none",
        approved: true,
        source: "public_user_edit",
      },
      operationIds: ["public-brief-update"],
    });
    expect(committed.project.revision).toBe(opened.project.revision + 1);
    expect(committed.editBrief.migration_status).toBeUndefined();
    const reopened = await openCreatorCutProject(fixture.projectDirectory);
    expect(reopened).toMatchObject({
      project: { revision: opened.project.revision + 1 },
      editBrief: {
        brief_id: "brief-public-after-handoff",
      },
    });
    expect(reopened.editBrief).not.toHaveProperty("migration_status");
  });

  it("restores an invalid public post-state before publishing its journal or marker", async () => {
    const fixture = await legacyFixture("invalid-post-state");
    await migrateLegacyInternalProject(fixture.projectDirectory, {
      backupDirectory: fixture.backupDirectory,
    });
    const state = join(fixture.projectDirectory, ".creatorcut");
    const transcriptPath = join(state, "transcript.json");
    const markerPath = join(state, "storage-authority.json");
    const journalPath = join(state, "storage-mutations.jsonl");
    const beforeTranscript = await readFile(transcriptPath);
    const beforeMarker = await readFile(markerPath);
    const beforeJournal = await readFile(journalPath);

    await expect(
      withPublicStorageMutation(
        state,
        "semantic_failure_test",
        async (marker) => {
          const transcript = JSON.parse(beforeTranscript.toString("utf8"));
          transcript.project_id = "another-project";
          await writeFile(transcriptPath, JSON.stringify(transcript));
          return {
            value: undefined,
            currentRevision: marker.current_revision,
          };
        },
      ),
    ).rejects.toThrow(/canonical|inconsistent|project/u);
    expect(await readFile(transcriptPath)).toEqual(beforeTranscript);
    expect(await readFile(markerPath)).toEqual(beforeMarker);
    expect(await readFile(journalPath)).toEqual(beforeJournal);
    expect(await exists(join(state, "pending-public-mutation.json"))).toBe(
      false,
    );
    await expect(
      openCreatorCutProject(fixture.projectDirectory),
    ).resolves.toMatchObject({ project: { revision: 3 } });
  });

  it("recovers an interrupted invalid mutation body from its durable before snapshot", async () => {
    const fixture = await legacyFixture("invalid-post-state-interrupted");
    await migrateLegacyInternalProject(fixture.projectDirectory, {
      backupDirectory: fixture.backupDirectory,
    });
    const state = join(fixture.projectDirectory, ".creatorcut");
    const transcriptPath = join(state, "transcript.json");
    const markerPath = join(state, "storage-authority.json");
    const journalPath = join(state, "storage-mutations.jsonl");
    const beforeTranscript = await readFile(transcriptPath);
    const beforeMarker = await readFile(markerPath);
    const beforeJournal = await readFile(journalPath);

    await expect(
      withPublicStorageMutation(
        state,
        "semantic_failure_interrupted",
        async (marker) => {
          const transcript = JSON.parse(beforeTranscript.toString("utf8"));
          transcript.project_id = "another-project";
          await writeFile(transcriptPath, JSON.stringify(transcript));
          return {
            value: undefined,
            currentRevision: marker.current_revision,
          };
        },
        { failureStage: "after_mutation_body" },
      ),
    ).rejects.toThrow("Injected failure: after_mutation_body");
    expect(await exists(join(state, "pending-public-mutation.json"))).toBe(
      true,
    );
    await expect(
      openCreatorCutProject(fixture.projectDirectory),
    ).resolves.toMatchObject({ project: { revision: 3 } });
    expect(await readFile(transcriptPath)).toEqual(beforeTranscript);
    expect(await readFile(markerPath)).toEqual(beforeMarker);
    expect(await readFile(journalPath)).toEqual(beforeJournal);
    expect(await exists(join(state, "pending-public-mutation.json"))).toBe(
      false,
    );
  });

  for (const failureStage of [
    "after_mutation_pending_write",
    "after_mutation_body",
    "after_mutation_journal",
    "after_mutation_marker",
    "after_mutation_stage_cleanup_before_pending_remove",
  ] satisfies PublicMutationFailureStage[]) {
    it(`recovers a public mutation after ${failureStage}`, async () => {
      const directory = await publicFixture(failureStage);
      const opened = await openCreatorCutProject(directory);
      const artifact = join(opened.creatorcutDirectory, "tasks", "wal.json");
      await expect(
        withPublicStorageMutation(
          opened.creatorcutDirectory,
          "wal_test",
          async (marker) => {
            await mkdir(dirname(artifact), { recursive: true });
            await writeFile(artifact, JSON.stringify({ committed: true }));
            return {
              value: undefined,
              currentRevision: marker.current_revision,
            };
          },
          { failureStage },
        ),
      ).rejects.toThrow(`Injected failure: ${failureStage}`);
      const recovered = await openCreatorCutProject(directory);
      const shouldCommit = [
        "after_mutation_marker",
        "after_mutation_stage_cleanup_before_pending_remove",
      ].includes(failureStage);
      expect(await exists(artifact)).toBe(shouldCommit);
      expect(recovered.authorityGeneration).toBe(
        opened.authorityGeneration + (shouldCommit ? 1 : 0),
      );
      expect(
        await exists(
          join(opened.creatorcutDirectory, "pending-public-mutation.json"),
        ),
      ).toBe(false);
    });
  }

  it("fails closed on a public mutation WAL created before pending publication", async () => {
    const directory = await publicFixture("wal-before-pending");
    const state = join(directory, ".creatorcut");
    const markerPath = join(state, "storage-authority.json");
    const markerBefore = await readFile(markerPath);
    await expect(
      withPublicStorageMutation(
        state,
        "wal_before_pending",
        async (marker) => ({
          value: undefined,
          currentRevision: marker.current_revision,
        }),
        { failureStage: "before_mutation_pending_write" },
      ),
    ).rejects.toThrow("Injected failure: before_mutation_pending_write");
    expect(await exists(join(state, "pending-public-mutation.json"))).toBe(
      false,
    );
    expect(await readdir(join(state, ".public-mutation"))).toHaveLength(1);
    await expect(openCreatorCutProject(directory)).rejects.toThrow(
      /unclaimed WAL state/u,
    );
    expect(await readFile(markerPath)).toEqual(markerBefore);
  });

  it("fails closed on a public mutation WAL left after pending removal", async () => {
    const directory = await publicFixture("wal-after-pending-remove");
    const state = join(directory, ".creatorcut");
    await expect(
      withPublicStorageMutation(
        state,
        "wal_after_pending_remove",
        async (marker) => ({
          value: undefined,
          currentRevision: marker.current_revision,
        }),
        {
          failureStage: "after_mutation_pending_remove_before_stage_cleanup",
        },
      ),
    ).rejects.toThrow(
      "Injected failure: after_mutation_pending_remove_before_stage_cleanup",
    );
    expect(await exists(join(state, "pending-public-mutation.json"))).toBe(
      false,
    );
    expect(await readdir(join(state, ".public-mutation"))).toHaveLength(1);
    await expect(openCreatorCutProject(directory)).rejects.toThrow(
      /unclaimed WAL state/u,
    );
  });

  it("rolls back a torn mutation body even when the next marker was durable", async () => {
    const directory = await publicFixture("torn-body-after-marker");
    const opened = await openCreatorCutProject(directory);
    const artifact = join(opened.creatorcutDirectory, "tasks", "torn.json");
    await expect(
      withPublicStorageMutation(
        opened.creatorcutDirectory,
        "torn_body_test",
        async (marker) => {
          await mkdir(dirname(artifact), { recursive: true });
          await writeFile(artifact, JSON.stringify({ committed: true }));
          return { value: undefined, currentRevision: marker.current_revision };
        },
        { failureStage: "after_mutation_marker" },
      ),
    ).rejects.toThrow("Injected failure: after_mutation_marker");
    await writeFile(artifact, "{torn", "utf8");
    const recovered = await openCreatorCutProject(directory);
    expect(recovered.authorityGeneration).toBe(opened.authorityGeneration);
    expect(await exists(artifact)).toBe(false);
    expect(
      await exists(
        join(opened.creatorcutDirectory, "pending-public-mutation.json"),
      ),
    ).toBe(false);
  });

  it("rejects a self-consistent replacement of the bound before snapshot without touching current state", async () => {
    const directory = await publicFixture("wal-bound-snapshot");
    const state = join(directory, ".creatorcut");
    const projectPath = join(state, "project.json");
    const markerPath = join(state, "storage-authority.json");
    const projectBefore = await readFile(projectPath);
    const markerBefore = await readFile(markerPath);
    await expect(
      withPublicStorageMutation(
        state,
        "bound_snapshot_attack",
        async (marker) => ({
          value: undefined,
          currentRevision: marker.current_revision,
        }),
        { failureStage: "after_mutation_pending_write" },
      ),
    ).rejects.toThrow("Injected failure: after_mutation_pending_write");
    const pending = JSON.parse(
      await readFile(join(state, "pending-public-mutation.json"), "utf8"),
    );
    const stage = join(state, ".public-mutation", pending.transaction_id);
    const stagedProjectPath = join(stage, "before", "project.json");
    const stagedProject = JSON.parse(await readFile(stagedProjectPath, "utf8"));
    await writeFile(
      stagedProjectPath,
      JSON.stringify({ ...stagedProject, name: "self-consistent-old-state" }),
    );
    await rebindPublicMutationSnapshot(state, false);

    await expect(openCreatorCutProject(directory)).rejects.toThrow(
      /snapshot no longer matches pending WAL/u,
    );
    expect(await readFile(projectPath)).toEqual(projectBefore);
    expect(await readFile(markerPath)).toEqual(markerBefore);
  });

  it("rejects protected paths in a rebound public mutation snapshot before restore", async () => {
    const directory = await publicFixture("wal-protected-snapshot-path");
    const state = join(directory, ".creatorcut");
    const projectPath = join(state, "project.json");
    const projectBefore = await readFile(projectPath);
    await expect(
      withPublicStorageMutation(
        state,
        "protected_snapshot_attack",
        async (marker) => ({
          value: undefined,
          currentRevision: marker.current_revision,
        }),
        { failureStage: "after_mutation_pending_write" },
      ),
    ).rejects.toThrow("Injected failure: after_mutation_pending_write");
    const pending = JSON.parse(
      await readFile(join(state, "pending-public-mutation.json"), "utf8"),
    );
    const stage = join(state, ".public-mutation", pending.transaction_id);
    const protectedRelativePath = "pending-public-mutation.json";
    await writeFile(
      join(stage, "before", protectedRelativePath),
      '{"attacker":"must-not-restore"}',
    );
    const manifestPath = join(stage, "snapshot.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files.push({
      relative_path: protectedRelativePath,
      sha256: sha256Hex('{"attacker":"must-not-restore"}'),
      size_bytes: Buffer.byteLength('{"attacker":"must-not-restore"}'),
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await rebindPublicMutationSnapshot(state, true);

    await expect(openCreatorCutProject(directory)).rejects.toThrow(
      /not managed metadata/u,
    );
    expect(await readFile(projectPath)).toEqual(projectBefore);
  });

  it("rejects a symlink byte swap in the bound before snapshot without reading its target", async () => {
    const directory = await publicFixture("wal-snapshot-symlink-swap");
    const state = join(directory, ".creatorcut");
    const projectPath = join(state, "project.json");
    const projectBefore = await readFile(projectPath);
    await expect(
      withPublicStorageMutation(
        state,
        "snapshot_symlink_attack",
        async (marker) => ({
          value: undefined,
          currentRevision: marker.current_revision,
        }),
        { failureStage: "after_mutation_pending_write" },
      ),
    ).rejects.toThrow("Injected failure: after_mutation_pending_write");
    const pending = JSON.parse(
      await readFile(join(state, "pending-public-mutation.json"), "utf8"),
    );
    const stage = join(state, ".public-mutation", pending.transaction_id);
    const stagedProjectPath = join(stage, "before", "project.json");
    const outside = join(dirname(directory), "outside-private-project.json");
    const outsideBytes = Buffer.from('{"private_prompt":"do-not-read"}');
    await writeFile(outside, outsideBytes);
    await rm(stagedProjectPath);
    await symlink(outside, stagedProjectPath);

    await expect(openCreatorCutProject(directory)).rejects.toThrow(
      /symbolic link|ELOOP|metadata path identity changed before read/iu,
    );
    expect(await readFile(projectPath)).toEqual(projectBefore);
    expect(await readFile(outside)).toEqual(outsideBytes);
  });

  it("rejects protected artifact namespaces for reads and writes", async () => {
    const directory = await publicFixture("artifact-protected");
    for (const relativePath of [
      "project.json",
      "timeline.json",
      "history.json",
      "operations.jsonl",
      "versions/0.json",
      "visual-composition.json",
      "storage-authority.json",
      "storage-mutations.jsonl",
      "pending-public-mutation.json",
      "project.lock",
      ".authority-migration/escape.json",
    ]) {
      await expect(
        writeLocalArtifact(directory, relativePath, { attacked: true }),
      ).rejects.toThrow(/task namespace|escapes/u);
    }
  });

  it("rejects unknown task kinds and private extra fields before creating a mutation WAL", async () => {
    const directory = await publicFixture("artifact-schema-preflight");
    const state = join(directory, ".creatorcut");
    const markerPath = join(state, "storage-authority.json");
    const markerBefore = await readFile(markerPath);
    const invalidExport = {
      schema_version: "creatorcut-export-task/1.0",
      task_id: "export:strict-schema",
      project_id: "project-public-artifact-schema-preflight",
      base_revision: 0,
      state: "queued",
      progress_millis: 0,
      created_at: "2026-08-09T00:00:00.000Z",
      updated_at: "2026-08-09T00:00:00.000Z",
      private_prompt: "must not enter managed metadata",
      source_path: "/Users/secret/source.mov",
    };

    await expect(
      writeLocalArtifact(directory, "tasks/private-provider.json", {
        provider_prompt: "private",
      }),
    ).rejects.toThrow(/unknown kind/u);
    await expect(
      writeLocalArtifact(directory, "tasks/export.json", invalidExport),
    ).rejects.toThrow(/not allowed/u);
    expect(await readFile(markerPath)).toEqual(markerBefore);
    await expect(
      access(join(state, "pending-public-mutation.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(state, ".public-mutation"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    await expect(
      access(join(state, "tasks", "export.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not read through a task parent symlink", async () => {
    const directory = await publicFixture("artifact-parent-read-symlink");
    const tasks = join(directory, ".creatorcut", "tasks");
    const originalTasks = `${tasks}.original`;
    const outside = await mkdtemp(
      join(tmpdir(), "creatorcut-artifact-read-outside-"),
    );
    const outsideArtifact = join(outside, "export.json");
    const privateBytes = Buffer.from(
      JSON.stringify({
        schema_version: "creatorcut-export-task/1.0",
        task_id: "export:outside-private",
        project_id: "migration-fixture",
        base_revision: 0,
        state: "queued",
        progress_millis: 0,
        created_at: "2026-08-09T00:00:00.000Z",
        updated_at: "2026-08-09T00:00:00.000Z",
      }),
    );
    await writeFile(outsideArtifact, privateBytes);
    await rename(tasks, originalTasks);
    await symlink(outside, tasks);

    await expect(
      readLocalArtifact(directory, "tasks/export.json"),
    ).rejects.toThrow(
      /symbolic link|symlink|trusted directory|canonical state/u,
    );
    expect(await readFile(outsideArtifact)).toEqual(privateBytes);
  });

  it("rejects a task parent symlink swap after the mutation WAL is durable without writing outside", async () => {
    const directory = await publicFixture("artifact-parent-write-symlink");
    const state = join(directory, ".creatorcut");
    const tasks = join(state, "tasks");
    const originalTasks = `${tasks}.original`;
    const outside = await mkdtemp(
      join(tmpdir(), "creatorcut-artifact-write-outside-"),
    );
    const sentinel = join(outside, "sentinel.txt");
    const sentinelBytes = Buffer.from("outside-must-remain-unchanged");
    const markerPath = join(state, "storage-authority.json");
    const markerBefore = await readFile(markerPath);
    const canonicalState = join(await realpath(directory), ".creatorcut");
    await writeFile(sentinel, sentinelBytes);
    readCheckpoint.afterRenamePath = join(
      canonicalState,
      "pending-public-mutation.json",
    );
    readCheckpoint.afterRenameAction = async () => {
      await rename(tasks, originalTasks);
      await symlink(outside, tasks);
    };

    await expect(
      writeLocalArtifact(directory, "tasks/export.json", {
        schema_version: "creatorcut-export-task/1.0",
        task_id: "export:parent-swap",
        project_id: "migration-fixture",
        base_revision: 0,
        state: "queued",
        progress_millis: 0,
        created_at: "2026-08-09T00:00:00.000Z",
        updated_at: "2026-08-09T00:00:00.000Z",
      }),
    ).rejects.toThrow(
      /symbolic link|symlink|trusted directory|changed|metadata/u,
    );
    expect(await readFile(sentinel)).toEqual(sentinelBytes);
    await expect(access(join(outside, "export.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(markerPath)).toEqual(markerBefore);

    await unlink(tasks);
    await rename(originalTasks, tasks);
    await expect(openCreatorCutProject(directory)).resolves.toMatchObject({
      authorityGeneration: 0,
      project: { revision: 0 },
    });
    await expect(access(join(tasks, "export.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      access(join(state, "pending-public-mutation.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  for (const mutation of [
    { label: "extra field", apply: (m: any) => ({ ...m, extra: true }) },
    {
      label: "wrong project",
      apply: (m: any) => ({ ...m, project_id: "wrong" }),
    },
    {
      label: "wrong revision",
      apply: (m: any) => ({ ...m, current_revision: 99 }),
    },
    {
      label: "wrong generation",
      apply: (m: any) => ({ ...m, generation: -1 }),
    },
    {
      label: "wrong digest",
      apply: (m: any) => ({
        ...m,
        canonical_state_digest: `sha256:${"0".repeat(64)}`,
      }),
    },
  ]) {
    it(`fails closed for a marker with ${mutation.label}`, async () => {
      const directory = await publicFixture(`marker-${mutation.label}`);
      const markerPath = join(
        directory,
        ".creatorcut",
        "storage-authority.json",
      );
      const marker = JSON.parse(await readFile(markerPath, "utf8"));
      await writeFile(markerPath, JSON.stringify(mutation.apply(marker)));
      await expect(openCreatorCutProject(directory)).rejects.toThrow(
        /authority marker|canonical state|current project|mutation journal/u,
      );
    });
  }

  it("blocks rollback after a same-revision public mutation", async () => {
    const fixture = await legacyFixture("rollback-same-revision");
    await migrateLegacyInternalProject(fixture.projectDirectory, {
      backupDirectory: fixture.backupDirectory,
    });
    await writeLocalArtifact(fixture.projectDirectory, "tasks/import.json", {
      schema_version: "creatorcut-import-task/1.0",
      state: "completed",
      source_asset_id: "asset-same-revision",
      source_sha256: "a".repeat(64),
      proxy_relative_path: "proxies/same-revision.mp4",
      proxy_sha256: "b".repeat(64),
      completed_at: "2026-08-09T00:00:00.000Z",
    });
    await expect(
      rollbackStorageAuthorityMigration(
        fixture.projectDirectory,
        fixture.backupDirectory,
      ),
    ).rejects.toThrow(/disabled after a public mutation/u);
  });

  it("rejects a rebound backup during a pending rollback", async () => {
    const fixture = await legacyFixture("rollback-bound-backup");
    const state = join(fixture.projectDirectory, ".creatorcut");
    await migrateLegacyInternalProject(fixture.projectDirectory, {
      backupDirectory: fixture.backupDirectory,
    });
    await expect(
      rollbackStorageAuthorityMigration(
        fixture.projectDirectory,
        fixture.backupDirectory,
        "after_pending_write",
      ),
    ).rejects.toThrow("Injected failure: after_pending_write");
    const markerPath = join(state, "storage-authority.json");
    const projectPath = join(state, "project.json");
    const markerBefore = await readFile(markerPath);
    const projectBefore = await readFile(projectPath);
    const manifest = JSON.parse(
      await readFile(join(fixture.backupDirectory, "manifest.json"), "utf8"),
    );
    const lastRelativePath = manifest.files.at(-1).relative_path as string;
    readCheckpoint.path = await realpath(
      join(fixture.backupDirectory, "metadata", ...lastRelativePath.split("/")),
    );
    readCheckpoint.count = 0;
    readCheckpoint.triggerCount = 1;
    readCheckpoint.action = async () => {
      await replaceBackupFileAndRebind(
        fixture.backupDirectory,
        "head.json",
        (value) => {
          const head = structuredClone(value) as any;
          head.snapshot.project.name = "unbound-rollback-backup";
          return head;
        },
      );
    };
    try {
      await expect(
        rollbackStorageAuthorityMigration(
          fixture.projectDirectory,
          fixture.backupDirectory,
        ),
      ).rejects.toThrow(/Pending rollback requires its exact backup/u);
      expect(await readFile(markerPath)).toEqual(markerBefore);
      expect(await readFile(projectPath)).toEqual(projectBefore);
      await expect(
        access(join(state, "pending-authority-migration.json")),
      ).resolves.toBeUndefined();
      expect(readCheckpoint.count).toBeGreaterThanOrEqual(1);
    } finally {
      readCheckpoint.path = "";
      readCheckpoint.count = 0;
      readCheckpoint.triggerCount = 0;
      readCheckpoint.action = undefined;
    }
  });

  it("never publishes rollback bytes through a replaced metadata parent", async () => {
    const fixture = await legacyFixture("rollback-parent-replacement");
    const state = join(fixture.projectDirectory, ".creatorcut");
    await migrateLegacyInternalProject(fixture.projectDirectory, {
      backupDirectory: fixture.backupDirectory,
    });
    const canonicalState = await realpath(state);
    const versions = join(canonicalState, "versions");
    const outside = join(dirname(fixture.projectDirectory), "outside-versions");
    await mkdir(outside);
    const sentinel = join(outside, "0.json");
    const sentinelBytes = Buffer.from('{"outside":"must-remain"}');
    await writeFile(sentinel, sentinelBytes);
    readCheckpoint.beforeRenamePath = versions;
    readCheckpoint.beforeRenameAction = async () => {
      await symlink(outside, versions);
    };
    try {
      await expect(
        rollbackStorageAuthorityMigration(
          fixture.projectDirectory,
          fixture.backupDirectory,
        ),
      ).rejects.toThrow();
      expect(await readFile(sentinel)).toEqual(sentinelBytes);
    } finally {
      readCheckpoint.beforeRenamePath = "";
      readCheckpoint.beforeRenameAction = undefined;
    }
  });

  for (const failureStage of [
    "after_mutation_body",
    "after_mutation_journal",
  ] satisfies PublicMutationFailureStage[]) {
    it(`recovers ${failureStage} before rolling authority back to internal`, async () => {
      const fixture = await legacyFixture(`rollback-wal-${failureStage}`);
      await migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
      });
      const state = join(fixture.projectDirectory, ".creatorcut");
      await expect(
        withPublicStorageMutation(
          state,
          "rollback_wal_test",
          async (marker) => {
            await mkdir(join(state, "tasks"), { recursive: true });
            await writeFile(
              join(state, "tasks", "crashed.json"),
              `${JSON.stringify({ crashed: true })}\n`,
            );
            return {
              value: undefined,
              currentRevision: marker.current_revision,
            };
          },
          { failureStage },
        ),
      ).rejects.toThrow(`Injected failure: ${failureStage}`);
      expect(await exists(join(state, "pending-public-mutation.json"))).toBe(
        true,
      );

      await expect(
        rollbackStorageAuthorityMigration(
          fixture.projectDirectory,
          fixture.backupDirectory,
        ),
      ).resolves.toMatchObject({ authority: "internal-project-store" });
      expect(await exists(join(state, "pending-public-mutation.json"))).toBe(
        false,
      );
      expect(await exists(join(state, ".public-mutation"))).toBe(false);
      await expect(
        openCreatorCutProject(fixture.projectDirectory),
      ).rejects.toThrow(/legacy internal storage|internal-project-store/u);
    });
  }
});

describe("migration history, leakage, staging, and rollback recovery", () => {
  for (const [label, corrupt] of [
    [
      "version filename revision",
      async (fixture: Awaited<ReturnType<typeof legacyFixture>>) => {
        const path = join(
          fixture.projectDirectory,
          ".creatorcut",
          "versions",
          "1.json",
        );
        const value = JSON.parse(await readFile(path, "utf8"));
        value.project.revision = 99;
        await writeFile(path, JSON.stringify(value));
      },
    ],
    [
      "history target",
      async (fixture: Awaited<ReturnType<typeof legacyFixture>>) => {
        const path = join(fixture.projectDirectory, ".creatorcut", "head.json");
        const value = JSON.parse(await readFile(path, "utf8"));
        value.history.undo_stack = [99];
        await writeFile(path, JSON.stringify(value));
      },
    ],
    [
      "operation chronology",
      async (fixture: Awaited<ReturnType<typeof legacyFixture>>) => {
        const path = join(
          fixture.projectDirectory,
          ".creatorcut",
          "operations.jsonl",
        );
        const lines = (await readFile(path, "utf8")).trim().split("\n");
        const second = JSON.parse(lines[1]!);
        second.base_revision = 0;
        lines[1] = JSON.stringify(second);
        await writeFile(path, `${lines.join("\n")}\n`);
      },
    ],
    [
      "optional clip gain type",
      async (fixture: Awaited<ReturnType<typeof legacyFixture>>) => {
        const state = join(fixture.projectDirectory, ".creatorcut");
        for (const relativePath of ["head.json", "versions/3.json"]) {
          const path = join(state, relativePath);
          const value = JSON.parse(await readFile(path, "utf8"));
          const snapshot =
            relativePath === "head.json" ? value.snapshot : value;
          snapshot.timeline.tracks[0].clips[0].gain_millibels = "-1200";
          await writeFile(path, JSON.stringify(value));
        }
      },
    ],
    [
      "visual enabled coercion",
      async (fixture: Awaited<ReturnType<typeof legacyFixture>>) => {
        const path = join(
          fixture.projectDirectory,
          ".creatorcut",
          "visual-composition-candidate.json",
        );
        const value = JSON.parse(await readFile(path, "utf8"));
        value.visual_events[0].enabled = "true";
        await writeFile(path, JSON.stringify(value));
      },
    ],
    [
      "unknown visual anchor",
      async (fixture: Awaited<ReturnType<typeof legacyFixture>>) => {
        const path = join(
          fixture.projectDirectory,
          ".creatorcut",
          "visual-composition-candidate.json",
        );
        const value = JSON.parse(await readFile(path, "utf8"));
        value.visual_events[0].anchor = { kind: "private_magic" };
        await writeFile(path, JSON.stringify(value));
      },
    ],
    [
      "private fine-cut sidecar field",
      async (fixture: Awaited<ReturnType<typeof legacyFixture>>) => {
        const path = join(
          fixture.projectDirectory,
          ".creatorcut",
          "fine-cut-card-chain.json",
        );
        const value = JSON.parse(await readFile(path, "utf8"));
        value.internal_prompt = "do not cross the public boundary";
        await writeFile(path, JSON.stringify(value));
      },
    ],
    [
      "wrong-project rough-cut sidecar",
      async (fixture: Awaited<ReturnType<typeof legacyFixture>>) => {
        const path = join(
          fixture.projectDirectory,
          ".creatorcut",
          "rough-cut-confirmation.json",
        );
        const value = JSON.parse(await readFile(path, "utf8"));
        value.project_id = "another-project";
        await writeFile(path, JSON.stringify(value));
      },
    ],
    [
      "generic internal task payload",
      async (fixture: Awaited<ReturnType<typeof legacyFixture>>) => {
        const tasks = join(fixture.projectDirectory, ".creatorcut", "tasks");
        await mkdir(tasks, { recursive: true });
        await writeFile(
          join(tasks, "private-task.json"),
          JSON.stringify({
            provider_prompt: "private",
            source_path: "/private/media",
          }),
        );
      },
    ],
  ] as const) {
    it(`rejects invalid ${label}`, async () => {
      const fixture = await legacyFixture(`invalid-${label}`);
      await corrupt(fixture);
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
        }),
      ).rejects.toThrow();
    });
  }

  it("rejects internal-only fields instead of copying or silently coercing them", async () => {
    const fixture = await legacyFixture("leakage");
    const state = join(fixture.projectDirectory, ".creatorcut");
    for (const relativePath of ["head.json", "versions/3.json"]) {
      const path = join(state, relativePath);
      const value = JSON.parse(await readFile(path, "utf8"));
      const snapshot = relativePath === "head.json" ? value.snapshot : value;
      snapshot.project.private_prompt = "never-public";
      snapshot.project.internal_path = "/Users/private/source.mov";
      snapshot.timeline.billing_policy = "secret";
      snapshot.visual_composition.private_server_note = "do-not-copy";
      await writeFile(path, JSON.stringify(value));
    }
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
      }),
    ).rejects.toThrow(/unsupported or missing fields/u);
  });

  it("keeps the legacy mutation journal only in rollback backup and binds a clean public journal", async () => {
    const fixture = await legacyFixture("private-mutation-journal");
    const state = join(fixture.projectDirectory, ".creatorcut");
    const journalPath = join(state, "storage-mutations.jsonl");
    const privateJournal = `${JSON.stringify({
      schema_version: "creatorcut-internal-mutation/0.1",
      provider_prompt: "private prompt must not cross authority",
      source_path: "/private/source.mov",
      approval_token: "visual_private_token",
      billing_policy: "internal-only",
    })}\n`;
    await writeFile(journalPath, privateJournal);

    const result = await migrateLegacyInternalProject(
      fixture.projectDirectory,
      { backupDirectory: fixture.backupDirectory },
    );
    const publicJournalText = await readFile(journalPath, "utf8");
    const publicJournal = publicJournalText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(publicJournal).toHaveLength(1);
    expect(publicJournal[0]).toEqual({
      schema_version: "creatorcut-storage-mutation/1.0",
      generation: 1,
      migration_id: result.migration_id,
      project_id: "migration-fixture",
      mutation_kind: "authority_handoff",
      project_revision: 3,
      canonical_state_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      committed_at: expect.any(String),
    });
    for (const secret of [
      "private prompt",
      "/private/source.mov",
      "visual_private_token",
      "internal-only",
    ]) {
      expect(publicJournalText).not.toContain(secret);
    }
    expect(
      await readFile(
        join(fixture.backupDirectory, "metadata", "storage-mutations.jsonl"),
        "utf8",
      ),
    ).toBe(privateJournal);
    await expect(
      openCreatorCutProject(fixture.projectDirectory),
    ).resolves.toMatchObject({ authorityGeneration: 1 });

    await rollbackStorageAuthorityMigration(
      fixture.projectDirectory,
      fixture.backupDirectory,
    );
    expect(await readFile(journalPath, "utf8")).toBe(privateJournal);
  });

  it("removes private runtime artifacts at handoff while preserving exact rollback bytes", async () => {
    const fixture = await legacyFixture("private-runtime-artifacts");
    const state = join(fixture.projectDirectory, ".creatorcut");
    const artifacts = new Map([
      [
        "director-consent.json",
        `${JSON.stringify({
          consent: false,
          private_prompt: "director private prompt",
          billing_policy: "private billing",
        })}\n`,
      ],
      [
        "director-state.json",
        `${JSON.stringify({
          status: "idle",
          provider_path: "/private/director-state",
          internal_policy: "never-public",
        })}\n`,
      ],
      [
        "preview-confirmation.json",
        `${JSON.stringify({
          approved: false,
          approval_token: "private-preview-token",
          source_path: "/private/preview.mov",
        })}\n`,
      ],
    ]);
    for (const [name, contents] of artifacts) {
      await writeFile(join(state, name), contents);
    }

    await migrateLegacyInternalProject(fixture.projectDirectory, {
      backupDirectory: fixture.backupDirectory,
    });
    for (const [name, contents] of artifacts) {
      expect(await exists(join(state, name))).toBe(false);
      expect(
        await readFile(join(fixture.backupDirectory, "metadata", name), "utf8"),
      ).toBe(contents);
    }
    const installedState = (await readdir(state, { recursive: true })).join(
      "\n",
    );
    expect(installedState).not.toContain("director private prompt");
    expect(installedState).not.toContain("private-preview-token");

    await rollbackStorageAuthorityMigration(
      fixture.projectDirectory,
      fixture.backupDirectory,
    );
    for (const [name, contents] of artifacts) {
      expect(await readFile(join(state, name), "utf8")).toBe(contents);
    }
  });

  it("fails closed when the public mutation journal no longer binds the marker", async () => {
    const directory = await publicFixture("journal-binding");
    const journalPath = join(
      directory,
      ".creatorcut",
      "storage-mutations.jsonl",
    );
    const entry = JSON.parse(await readFile(journalPath, "utf8"));
    entry.project_id = "wrong-project";
    await writeFile(journalPath, `${JSON.stringify(entry)}\n`);
    await expect(openCreatorCutProject(directory)).rejects.toThrow(
      /mutation journal authority binding/u,
    );
  });

  it("verifies the visual handoff without returning the approval token", async () => {
    const fixture = await legacyFixture("handoff-token-redaction");
    const chainPath = join(
      fixture.projectDirectory,
      ".creatorcut",
      "fine-cut-card-chain.json",
    );
    const token = JSON.parse(await readFile(chainPath, "utf8"))
      .preview_approval_token as string;
    await migrateLegacyInternalProject(fixture.projectDirectory, {
      backupDirectory: fixture.backupDirectory,
    });
    const verification = await verifyMigratedVisualHandoff(
      fixture.projectDirectory,
    );
    expect(verification).toMatchObject({
      preview_approval_present: true,
      preview_binding_valid: true,
      visual_state: "active",
      next: "export_plan",
    });
    expect(JSON.stringify(verification)).not.toContain(token);
    expect(verification.visual_handoff_present).toBe(true);
    if (!verification.visual_handoff_present) {
      throw new Error("Expected migrated visual handoff evidence");
    }
    expect(verification.preview_token_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("detects a tampered stage-complete canonical output before install", async () => {
    const fixture = await legacyFixture("stage-digest");
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
        migrationId: "stage-digest",
        failureStage: "after_staging_write",
      }),
    ).rejects.toThrow("Injected failure");
    const stagedProject = join(
      fixture.projectDirectory,
      ".creatorcut",
      ".authority-migration",
      "stage-digest",
      "canonical",
      "project.json",
    );
    await writeFile(stagedProject, JSON.stringify({ tampered: true }));
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
      }),
    ).rejects.toThrow(/staged canonical metadata digest mismatch/u);
    await expect(
      access(
        join(
          fixture.projectDirectory,
          ".creatorcut",
          "pending-authority-migration.json",
        ),
      ),
    ).resolves.toBeUndefined();
    expect(
      JSON.parse(
        await readFile(
          join(fixture.projectDirectory, ".creatorcut", "head.json"),
          "utf8",
        ),
      ).snapshot.project.project_id,
    ).toBe("migration-fixture");
  });

  it("rejects a self-consistent stage swapped after caller verification but before install verification", async () => {
    const fixture = await legacyFixture("stage-install-binding-swap");
    const state = join(fixture.projectDirectory, ".creatorcut");
    const migrationId = "stage-install-binding-swap";
    const stage = join(state, ".authority-migration", migrationId);
    const pendingPath = join(state, "pending-authority-migration.json");
    const stagedProject = join(stage, "canonical", "project.json");
    readCheckpoint.afterRenamePath = pendingPath;
    readCheckpoint.afterRenameCount = 0;
    readCheckpoint.afterRenameTriggerCount = 3;
    readCheckpoint.afterRenameAction = async () => {
      const project = JSON.parse(await readFile(stagedProject, "utf8"));
      await writeFile(
        stagedProject,
        JSON.stringify({ ...project, name: "unbound-install-stage" }),
      );
      const currentVersionPath = join(
        stage,
        "canonical",
        "versions",
        `${project.revision}.json`,
      );
      const currentVersion = JSON.parse(
        await readFile(currentVersionPath, "utf8"),
      );
      await writeFile(
        currentVersionPath,
        JSON.stringify({
          ...currentVersion,
          project: {
            ...currentVersion.project,
            name: "unbound-install-stage",
          },
        }),
      );
      await rebindStageManifest(stage);
    };
    try {
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
          migrationId,
        }),
      ).rejects.toThrow(/Pending migration stage digest changed/u);
      await expect(access(join(state, "head.json"))).resolves.toBeUndefined();
      await expect(
        access(join(state, "storage-authority.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(readCheckpoint.afterRenameCount).toBeGreaterThanOrEqual(3);
    } finally {
      readCheckpoint.afterRenamePath = "";
      readCheckpoint.afterRenameCount = 0;
      readCheckpoint.afterRenameTriggerCount = 1;
      readCheckpoint.afterRenameAction = undefined;
    }
  });

  for (const attack of ["valid-byte-swap", "symlink-swap"] as const) {
    it(`installs only verified buffers and preserves a ${attack} stage for review`, async () => {
      const fixture = await legacyFixture(`stage-copy-${attack}`);
      const state = join(fixture.projectDirectory, ".creatorcut");
      const migrationId = `stage-copy-${attack}`;
      const stagedProject = join(
        state,
        ".authority-migration",
        migrationId,
        "canonical",
        "project.json",
      );
      let outside = "";
      let outsideBytes = Buffer.alloc(0);
      readCheckpoint.afterRmPath = resolve(state, "versions");
      readCheckpoint.afterRmAction = async () => {
        if (attack === "valid-byte-swap") {
          const project = JSON.parse(await readFile(stagedProject, "utf8"));
          await writeFile(
            stagedProject,
            JSON.stringify({ ...project, name: "unbound-stage-name" }),
          );
          return;
        }
        outside = join(dirname(fixture.projectDirectory), "outside-stage.json");
        outsideBytes = Buffer.from(
          '{"private_prompt":"must-not-install-or-delete"}',
        );
        await writeFile(outside, outsideBytes);
        await rm(stagedProject);
        await symlink(outside, stagedProject);
      };

      try {
        await expect(
          migrateLegacyInternalProject(fixture.projectDirectory, {
            backupDirectory: fixture.backupDirectory,
            migrationId,
          }),
        ).rejects.toThrow(
          attack === "valid-byte-swap"
            ? /Authority staged canonical metadata digest mismatch/u
            : /Metadata contains symbolic link: project\.json/u,
        );
        const installed = JSON.parse(
          await readFile(join(state, "project.json"), "utf8"),
        );
        expect(installed.name).not.toBe("unbound-stage-name");
        expect(JSON.stringify(installed)).not.toContain("private_prompt");
        if (outside) expect(await readFile(outside)).toEqual(outsideBytes);
        await expect(
          access(join(state, "storage-authority.json")),
        ).resolves.toBeUndefined();
        await expect(
          access(join(state, "pending-authority-migration.json")),
        ).resolves.toBeUndefined();
        await expect(access(stagedProject)).resolves.toBeUndefined();
        expect(readCheckpoint.afterRmAction).toBeUndefined();
      } finally {
        readCheckpoint.afterRmPath = "";
        readCheckpoint.afterRmAction = undefined;
      }
    });
  }

  it("builds the stage from the bound backup when source bytes swap and revert during conversion", async () => {
    const fixture = await legacyFixture("source-stage-swap-revert");
    const state = join(fixture.projectDirectory, ".creatorcut");
    const migrationId = "source-stage-swap-revert";
    await expect(
      migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
        migrationId,
        failureStage: "after_pending_write",
      }),
    ).rejects.toThrow("Injected failure: after_pending_write");
    const canonicalState = join(
      await realpath(fixture.projectDirectory),
      ".creatorcut",
    );
    const headPath = join(canonicalState, "head.json");
    const headBefore = await readFile(headPath);
    const backupManifestPath = join(
      await realpath(fixture.backupDirectory),
      "manifest.json",
    );
    readCheckpoint.path = backupManifestPath;
    readCheckpoint.count = 0;
    readCheckpoint.triggerCount = 2;
    readCheckpoint.action = async () => {
      const head = JSON.parse(headBefore.toString("utf8"));
      head.snapshot.project.name = "unbound-source-swap";
      await writeFile(headPath, JSON.stringify(head));
      readCheckpoint.beforeOpenPath = headPath;
      readCheckpoint.beforeOpenAction = async () => {
        await writeFile(headPath, headBefore);
      };
    };
    try {
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
        }),
      ).resolves.toMatchObject({ status: "migrated" });
      const installed = JSON.parse(
        await readFile(join(state, "project.json"), "utf8"),
      );
      expect(installed.name).not.toBe("unbound-source-swap");
      expect(readCheckpoint.count).toBeGreaterThanOrEqual(2);
    } finally {
      readCheckpoint.path = "";
      readCheckpoint.count = 0;
      readCheckpoint.triggerCount = 0;
      readCheckpoint.action = undefined;
      readCheckpoint.beforeOpenPath = "";
      readCheckpoint.beforeOpenAction = undefined;
    }
  });

  for (const corruption of [
    "wrong-history-target",
    "wrong-restored-target",
    "wrong-operation-chronology",
    "extra-revision",
    "missing-revision",
  ] as const) {
    it(`rejects semantically invalid staged canonical metadata: ${corruption}`, async () => {
      const fixture = await legacyFixture(`stage-semantic-${corruption}`);
      const migrationId = `stage-semantic-${corruption}`;
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
          migrationId,
          failureStage: "after_staging_write",
        }),
      ).rejects.toThrow("Injected failure: after_staging_write");
      const state = join(fixture.projectDirectory, ".creatorcut");
      const stage = join(state, ".authority-migration", migrationId);
      const canonical = join(stage, "canonical");
      if (corruption === "wrong-history-target") {
        const path = join(canonical, "history.json");
        const history = JSON.parse(await readFile(path, "utf8"));
        await writeFile(path, JSON.stringify({ ...history, undo_stack: [99] }));
      } else if (corruption === "wrong-restored-target") {
        const path = join(canonical, "versions", "2.json");
        const snapshot = JSON.parse(await readFile(path, "utf8"));
        await writeFile(
          path,
          JSON.stringify({ ...snapshot, restored_from_revision: 1 }),
        );
      } else if (corruption === "wrong-operation-chronology") {
        const path = join(canonical, "operations.jsonl");
        const operations = (await readFile(path, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        operations[1] = { ...operations[1], base_revision: 0 };
        await writeFile(
          path,
          `${operations.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        );
      } else if (corruption === "extra-revision") {
        await writeFile(join(canonical, "versions", "99.json"), "{}\n");
      } else {
        await rm(join(canonical, "versions", "1.json"));
      }
      await rebindStageManifest(stage);
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
        }),
      ).rejects.toThrow(/canonical|history|operation|revision|restore/u);
      await expect(access(join(state, "head.json"))).resolves.toBeUndefined();
      await expect(
        access(join(state, "pending-authority-migration.json")),
      ).resolves.toBeUndefined();
    });
  }

  it("validates installed canonical metadata before removing legacy authority", async () => {
    const fixture = await legacyFixture("installed-semantic-validation");
    const state = join(fixture.projectDirectory, ".creatorcut");
    const installedHistory = join(state, "history.json");
    readCheckpoint.beforeReadFilePath = installedHistory;
    readCheckpoint.beforeReadFileAction = async () => {
      await writeFile(installedHistory, JSON.stringify({ tampered: true }));
    };
    try {
      await expect(
        migrateLegacyInternalProject(fixture.projectDirectory, {
          backupDirectory: fixture.backupDirectory,
          migrationId: "installed-semantic-validation",
        }),
      ).rejects.toThrow(/canonical|history|fields/u);
      await expect(access(join(state, "head.json"))).resolves.toBeUndefined();
      await expect(
        access(join(state, "pending-authority-migration.json")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(state, "storage-authority.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        rollbackStorageAuthorityMigration(
          fixture.projectDirectory,
          fixture.backupDirectory,
        ),
      ).resolves.toMatchObject({ status: "rolled_back", recovered: true });
      await expect(access(join(state, "head.json"))).resolves.toBeUndefined();
      await expect(
        access(join(state, "pending-authority-migration.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        openCreatorCutProject(fixture.projectDirectory),
      ).rejects.toThrow(/authority|migration|legacy/u);
    } finally {
      readCheckpoint.beforeReadFilePath = "";
      readCheckpoint.beforeReadFileAction = undefined;
    }
  });

  for (const failureStage of [
    "after_pending_write",
    "after_mirrors_replace",
  ] as const) {
    it(`re-enters rollback after ${failureStage} with an internal marker restored`, async () => {
      const fixture = await legacyFixture(`rollback-recovery-${failureStage}`);
      const state = join(fixture.projectDirectory, ".creatorcut");
      await writeFile(
        join(state, "storage-authority.json"),
        JSON.stringify({
          schema_version: "creatorcut-storage-authority/1.0",
          authority: "internal-project-store",
          project_id: "migration-fixture",
        }),
      );
      await migrateLegacyInternalProject(fixture.projectDirectory, {
        backupDirectory: fixture.backupDirectory,
      });
      await expect(
        rollbackStorageAuthorityMigration(
          fixture.projectDirectory,
          fixture.backupDirectory,
          failureStage,
        ),
      ).rejects.toThrow("Injected failure");
      await expect(
        rollbackStorageAuthorityMigration(
          fixture.projectDirectory,
          fixture.backupDirectory,
        ),
      ).resolves.toMatchObject({ status: "rolled_back", recovered: true });
      const authority = JSON.parse(
        await readFile(join(state, "storage-authority.json"), "utf8"),
      );
      expect(authority.authority).toBe("internal-project-store");
    });
  }
});
