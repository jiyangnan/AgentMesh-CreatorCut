import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  runProcess,
  sha256File,
  type ProcessRunner,
} from "@agentmesh/creatorcut-media-engine";
import {
  compareAndSwapLocalArtifact,
  localArtifactDigest,
  openCreatorCutProject,
  finalizePrivateWorkFile,
  preparePrivateWorkDirectory,
  privateWorkPath,
  readLocalArtifact,
  redactPrivateText,
  releasePrivateWorkDirectory,
  removePrivateWorkNamespace,
  writeLocalArtifact,
  type LocalTranscript,
  type LocalTranscriptSilenceInterval,
  type PrivateWorkDirectoryLease,
} from "@agentmesh/creatorcut-runtime";

import { detectTranscriptLanguage, parseWhisperJson } from "./whisper-json.js";
import type {
  Candidate,
  LanguageMode,
  TranscribeProjectOptions,
  TranscriptionLocator,
  TranscriptionTask,
  WhisperJson,
} from "./types.js";

const TASK_PATH = "tasks/transcription.json";
const LOCATOR_PATH = "tasks/transcription-locator.json";

async function safeAssetPath(
  projectDirectory: string,
  relativePath: string,
): Promise<string> {
  const root = await realpath(resolve(projectDirectory));
  const requested = resolve(root, relativePath);
  const lexicalFromRoot = relative(root, requested);
  if (lexicalFromRoot.startsWith("..") || isAbsolute(lexicalFromRoot)) {
    throw new Error("CreatorCut transcription source escapes the project");
  }
  const canonicalPath = await realpath(requested);
  const canonicalFromRoot = relative(root, canonicalPath);
  if (canonicalFromRoot.startsWith("..") || isAbsolute(canonicalFromRoot)) {
    throw new Error("CreatorCut transcription source escapes the project");
  }
  return canonicalPath;
}

function parseSilence(
  stderr: string,
  sourceAssetId: string,
  durationUs: number,
): LocalTranscriptSilenceInterval[] {
  const events = [
    ...stderr.matchAll(/silence_(start|end):\s*([0-9]+(?:\.[0-9]+)?)/gu),
  ];
  const result: LocalTranscriptSilenceInterval[] = [];
  let start: number | null = null;
  for (const event of events) {
    const value = Math.max(
      0,
      Math.min(durationUs, Math.round(Number(event[2]) * 1_000_000)),
    );
    if (event[1] === "start") {
      start = value;
    } else if (start !== null && value > start) {
      result.push({
        silence_id: `silence_${String(result.length).padStart(4, "0")}`,
        source_asset_id: sourceAssetId,
        start_us: start,
        end_us: value,
      });
      start = null;
    }
  }
  if (start !== null && durationUs > start) {
    result.push({
      silence_id: `silence_${String(result.length).padStart(4, "0")}`,
      source_asset_id: sourceAssetId,
      start_us: start,
      end_us: durationUs,
    });
  }
  return result;
}

function candidateScore(candidate: Candidate): number {
  const tokens = candidate.transcript.segments.flatMap(
    (segment) => segment.tokens,
  );
  const languages = new Set(
    tokens
      .map((token) => token.language)
      .filter((language) => language === "zh" || language === "en"),
  );
  const mean =
    tokens.length === 0
      ? 0
      : tokens.reduce((sum, token) => sum + token.confidence, 0) /
        tokens.length;
  return languages.size * 1000 + mean * 100 + Math.min(tokens.length, 100);
}

async function runCandidate(input: {
  runner: ProcessRunner;
  whisperPath: string;
  modelPath: string;
  audioPath: string;
  outputPrefix: string;
  language: "auto" | "zh" | "en";
  glossary: string[];
  projectId: string;
  projectRevision: number;
  sourceAssetId: string;
  languageMode: LanguageMode;
  workLease: PrivateWorkDirectoryLease;
  signal?: AbortSignal;
}): Promise<Candidate> {
  const prefix = `${input.outputPrefix}-${input.language}`;
  const outputPath = `${prefix}.json`;
  const cached = await finalizePrivateWorkFile(input.workLease, outputPath)
    .then(() => readFile(outputPath, "utf8"))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  let raw: WhisperJson;
  if (cached) {
    raw = JSON.parse(cached) as WhisperJson;
  } else {
    const args = [
      "-m",
      input.modelPath,
      "-f",
      input.audioPath,
      "-l",
      input.language,
      "-ojf",
      "-of",
      prefix,
      "-np",
      "-sow",
      "-wt",
      "0.01",
    ];
    if (input.glossary.length > 0) {
      args.push("--prompt", input.glossary.join(", "));
    }
    let result = await input.runner(input.whisperPath, args, input.signal);
    let output = await finalizePrivateWorkFile(input.workLease, outputPath)
      .then(() => readFile(outputPath, "utf8"))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (result.exitCode !== 0 || !output) {
      await rm(outputPath, { force: true });
      result = await input.runner(
        input.whisperPath,
        [...args, "-ng"],
        input.signal,
      );
      output = await finalizePrivateWorkFile(input.workLease, outputPath)
        .then(() => readFile(outputPath, "utf8"))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
    }
    if (result.exitCode !== 0 || !output) {
      throw new Error(
        `Local whisper.cpp transcription failed: ${result.stderr.trim()}`,
      );
    }
    raw = JSON.parse(output) as WhisperJson;
  }
  return {
    language: input.language,
    raw,
    transcript: parseWhisperJson(raw, {
      projectId: input.projectId,
      projectRevision: input.projectRevision,
      sourceAssetId: input.sourceAssetId,
      languageMode: input.languageMode,
    }),
  };
}

async function persistTask(
  projectDirectory: string,
  expected: TranscriptionTask | null,
  task: TranscriptionTask,
  transcript?: LocalTranscript,
): Promise<TranscriptionTask> {
  const opened = await openCreatorCutProject(projectDirectory);
  const result = await compareAndSwapLocalArtifact<TranscriptionTask, null>(
    opened.directory,
    TASK_PATH,
    {
      projectId: opened.project.project_id,
      revision: opened.project.revision,
      authorityGeneration: opened.authorityGeneration,
      artifactDigest: localArtifactDigest(expected),
      mutationKind: transcript
        ? "transcription_complete"
        : "transcription_task_transition",
    },
    async () => ({
      nextArtifact: task,
      value: null,
      ...(transcript ? { nextTranscript: transcript } : {}),
    }),
  );
  return result.artifact;
}

export async function transcribeProject(
  options: TranscribeProjectOptions,
): Promise<TranscriptionTask> {
  const opened = await openCreatorCutProject(options.projectDirectory);
  const source =
    opened.project.assets.find((asset) => asset.kind === "video") ??
    opened.project.assets.find((asset) => asset.kind === "audio");
  if (!source) throw new Error("CreatorCut project has no transcribable asset");
  const sourcePath = await safeAssetPath(
    opened.directory,
    source.relative_path,
  );
  const modelPath = await realpath(resolve(options.modelPath));
  const runner = options.runner ?? runProcess;
  const now = new Date().toISOString();
  const task: TranscriptionTask = {
    schema_version: "creatorcut-transcription-task/1.0",
    task_id: `transcription:${randomUUID()}`,
    project_id: opened.project.project_id,
    base_revision: opened.project.revision,
    source_asset_id: source.asset_id,
    source_sha256: source.sha256,
    model_sha256: await sha256File(modelPath),
    language_mode: options.languageMode,
    glossary: options.glossary ?? [],
    state: "queued",
    progress_millis: 0,
    completed_steps: [],
    created_at: now,
    updated_at: now,
  };
  const previousTask = await readTranscriptionTask(opened.directory);
  let current = await persistTask(opened.directory, previousTask, task);
  const locator: TranscriptionLocator = {
    schema_version: "creatorcut-transcription-locator/1.0",
    source_path: sourcePath,
    model_path: modelPath,
    whisper_path: options.whisperPath ?? "whisper-cli",
    ffmpeg_path: options.ffmpegPath ?? "ffmpeg",
    ffprobe_path: options.ffprobePath ?? "ffprobe",
  };
  await writeLocalArtifact(opened.directory, LOCATOR_PATH, locator);
  const workKey = createHash("sha256")
    .update(
      JSON.stringify({
        source_sha256: task.source_sha256,
        model_sha256: task.model_sha256,
        language_mode: task.language_mode,
        glossary: task.glossary,
      }),
    )
    .digest("hex")
    .slice(0, 24);
  const workLease = await preparePrivateWorkDirectory(opened.directory, [
    "transcription",
    workKey,
  ]);
  const work = workLease.directory;
  const audioPath = privateWorkPath(workLease, "audio.wav");
  current = await persistTask(opened.directory, current, {
    ...current,
    state: "running",
    progress_millis: 50,
    updated_at: new Date().toISOString(),
  });
  try {
    const preparedExists = await finalizePrivateWorkFile(workLease, audioPath)
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
    if (!preparedExists) {
      const prepared = await runner(
        locator.ffmpeg_path,
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          sourcePath,
          "-vn",
          "-ar",
          "16000",
          "-ac",
          "1",
          "-c:a",
          "pcm_s16le",
          audioPath,
        ],
        options.signal,
      );
      if (prepared.exitCode !== 0) {
        throw new Error(
          `CreatorCut audio preparation failed: ${prepared.stderr.trim()}`,
        );
      }
      await finalizePrivateWorkFile(workLease, audioPath);
    }
    current = await persistTask(opened.directory, current, {
      ...current,
      progress_millis: 250,
      completed_steps: ["audio_prepared"],
      updated_at: new Date().toISOString(),
    });
    const silenceRun = await runner(
      locator.ffmpeg_path,
      [
        "-nostdin",
        "-hide_banner",
        "-i",
        audioPath,
        "-af",
        "silencedetect=noise=-35dB:d=0.35",
        "-f",
        "null",
        "-",
      ],
      options.signal,
    );
    const silence = parseSilence(
      silenceRun.stderr,
      source.asset_id,
      source.duration_us,
    );
    current = await persistTask(opened.directory, current, {
      ...current,
      progress_millis: 350,
      completed_steps: ["audio_prepared", "silence_detected"],
      updated_at: new Date().toISOString(),
    });
    const languages: Array<"auto" | "zh" | "en"> =
      options.languageMode === "mixed"
        ? ["auto", "zh", "en"]
        : [options.languageMode === "auto" ? "auto" : options.languageMode];
    const candidates: Candidate[] = [];
    for (const language of languages) {
      candidates.push(
        await runCandidate({
          runner,
          whisperPath: locator.whisper_path,
          modelPath,
          audioPath,
          outputPrefix: join(work, "candidate"),
          language,
          glossary: task.glossary,
          projectId: opened.project.project_id,
          projectRevision: opened.project.revision,
          sourceAssetId: source.asset_id,
          languageMode: options.languageMode,
          workLease,
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      );
      current = await persistTask(opened.directory, current, {
        ...current,
        progress_millis: Math.min(850, current.progress_millis + 150),
        completed_steps: [...current.completed_steps, `candidate_${language}`],
        updated_at: new Date().toISOString(),
      });
    }
    const selected = [...candidates].sort(
      (left, right) => candidateScore(right) - candidateScore(left),
    )[0];
    if (!selected)
      throw new Error("CreatorCut transcription produced no candidate");
    const transcript: LocalTranscript = {
      ...selected.transcript,
      silence_intervals: silence,
    };
    const completed: TranscriptionTask = {
      ...current,
      state: "completed",
      progress_millis: 1000,
      completed_steps: [...current.completed_steps, "transcript_persisted"],
      updated_at: new Date().toISOString(),
      result: {
        transcript_id: transcript.transcript_id,
        detected_language: detectTranscriptLanguage(transcript),
        segment_count: transcript.segments.length,
        token_count: transcript.segments.reduce(
          (count, segment) => count + segment.tokens.length,
          0,
        ),
      },
    };
    return await persistTask(opened.directory, current, completed, transcript);
  } catch (error) {
    const latest = await readTranscriptionTask(opened.directory);
    if (latest?.task_id === task.task_id && latest.state === "cancelled") {
      return latest;
    }
    const failed: TranscriptionTask = {
      ...current,
      state: "failed",
      updated_at: new Date().toISOString(),
      error: {
        code: "transcription_failed",
        message: redactPrivateText(
          error instanceof Error ? error.message : "Transcription failed",
        ),
      },
    };
    if (latest?.task_id !== task.task_id) return failed;
    try {
      return await persistTask(opened.directory, latest, failed);
    } catch {
      const raced = await readTranscriptionTask(opened.directory);
      return raced?.task_id === task.task_id ? raced : failed;
    }
  } finally {
    await releasePrivateWorkDirectory(workLease);
  }
}

export function readTranscriptionTask(
  projectDirectory: string,
): Promise<TranscriptionTask | null> {
  return readLocalArtifact<TranscriptionTask>(projectDirectory, TASK_PATH);
}

export async function cancelTranscriptionTask(
  projectDirectory: string,
): Promise<TranscriptionTask> {
  const task = await readTranscriptionTask(projectDirectory);
  if (!task) throw new Error("CreatorCut transcription task is missing");
  if (task.state === "completed") {
    throw new Error("Completed CreatorCut transcription cannot be cancelled");
  }
  const cancelled: TranscriptionTask = {
    ...task,
    state: "cancelled",
    updated_at: new Date().toISOString(),
  };
  try {
    return await persistTask(projectDirectory, task, cancelled);
  } catch (error) {
    const latest = await readTranscriptionTask(projectDirectory);
    if (latest?.task_id === task.task_id && latest.state === "cancelled") {
      return latest;
    }
    if (latest?.task_id === task.task_id && latest.state === "completed") {
      throw new Error("Completed CreatorCut transcription cannot be cancelled");
    }
    throw error;
  }
}

export async function resumeTranscriptionTask(
  projectDirectory: string,
  options: Pick<TranscribeProjectOptions, "runner" | "signal"> = {},
): Promise<TranscriptionTask> {
  let locator: TranscriptionLocator | null;
  let task: TranscriptionTask | null;
  try {
    locator = await readLocalArtifact<TranscriptionLocator>(
      projectDirectory,
      LOCATOR_PATH,
    );
    task = await readTranscriptionTask(projectDirectory);
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message === `CreatorCut artifact is stale: ${TASK_PATH}`
    ) {
      throw new Error(
        "CreatorCut transcription recovery state is stale for the current revision",
      );
    }
    throw error;
  }
  if (!locator || !task)
    throw new Error("CreatorCut transcription recovery state is missing");
  const opened = await openCreatorCutProject(projectDirectory);
  const source = opened.project.assets.find(
    (asset) => asset.asset_id === task.source_asset_id,
  );
  if (
    task.project_id !== opened.project.project_id ||
    task.base_revision !== opened.project.revision ||
    !source ||
    source.sha256 !== task.source_sha256
  ) {
    throw new Error(
      "CreatorCut transcription recovery state is stale for the current revision",
    );
  }
  if (task.state === "completed") return task;
  return transcribeProject({
    projectDirectory,
    modelPath: locator.model_path,
    whisperPath: locator.whisper_path,
    ffmpegPath: locator.ffmpeg_path,
    ffprobePath: locator.ffprobe_path,
    languageMode: task.language_mode,
    glossary: task.glossary,
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export async function clearTranscriptionWork(
  projectDirectory: string,
): Promise<void> {
  await removePrivateWorkNamespace(projectDirectory, "transcription");
}

export { parseSilence };
