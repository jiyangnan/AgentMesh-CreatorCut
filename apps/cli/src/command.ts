import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  KeychainCredentialStore,
  type CredentialStore,
} from "@agentmesh/creatorcut-credentials";
import {
  CloudDirectorAdapter,
  loadVerifiedDirectorKeyset,
} from "@agentmesh/creatorcut-director-client";
import { answerSetIdForPresentation } from "@agentmesh/creatorcut-host-adapters";
import {
  applyPreviewedManifest,
  cancelExportTask,
  importMedia,
  previewSignedManifest,
  readExportTask,
  resumeExportTask,
  startExportTask,
} from "@agentmesh/creatorcut-media-engine";
import {
  approveDirectorContext,
  buildDirectorContext,
  inspectDirectorContext,
  openCreatorCutProject,
  readDirectorConsent,
  redoLocalRevision,
  replaceLocalTranscript,
  revokeDirectorConsent,
  type LocalTranscript,
  undoLocalRevision,
} from "@agentmesh/creatorcut-runtime";
import {
  cancelTranscriptionTask,
  readTranscriptionTask,
  resumeTranscriptionTask,
  transcribeProject,
  type LanguageMode,
} from "@agentmesh/creatorcut-transcription";
import {
  applyManagedUpdate,
  fetchVerifiedReleaseManifest,
  findActiveProjectTasks,
  loadVerifiedReleaseKeyset,
  readManagedInstallMetadata,
  releaseCheck,
} from "@agentmesh/creatorcut-release-manager";

import type { CliEnvelope, CliIo } from "./types.js";

const CURRENT_CLIENT_VERSION = "0.1.0-rc.9";
const DEFAULT_RELEASE_ENDPOINT =
  "https://api.agentmesh360.com/v1/products/creatorcut/client-release";

interface ParsedArguments {
  command: string[];
  options: Map<string, string | true>;
}

interface CliDependencies {
  credentials?: CredentialStore;
  adapterFactory?: () => Promise<CloudDirectorAdapter>;
  cwd?: () => string;
}

function parseArguments(argv: string[]): ParsedArguments {
  const command: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (!token.startsWith("--")) {
      command.push(token);
      continue;
    }
    if (token === "--key") {
      throw new TypeError(
        "CreatorCut never accepts API keys in command arguments",
      );
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options.set(token.slice(2), next);
      index += 1;
    } else {
      options.set(token.slice(2), true);
    }
  }
  return { command, options };
}

function option(
  parsed: ParsedArguments,
  name: string,
  environmentName?: string,
): string | undefined {
  const value = parsed.options.get(name);
  if (typeof value === "string") return value;
  return environmentName ? process.env[environmentName] : undefined;
}

function requiredOption(
  parsed: ParsedArguments,
  name: string,
  environmentName?: string,
): string {
  const value = option(parsed, name, environmentName);
  if (!value) {
    throw new TypeError(
      `CreatorCut requires --${name}${
        environmentName ? ` or ${environmentName}` : ""
      }`,
    );
  }
  return value;
}

function success<T>(
  command: string,
  data: T,
  options: {
    revision?: number;
    next?: string;
    requiresUserAction?: boolean;
    userPrompt?: string;
  } = {},
): CliEnvelope<T> {
  return {
    schema_version: "creatorcut-cli/1.0",
    ok: true,
    command,
    ...(options.revision === undefined
      ? {}
      : { project_revision: options.revision }),
    requires_user_action: options.requiresUserAction ?? false,
    ...(options.userPrompt ? { user_prompt: options.userPrompt } : {}),
    retryable: false,
    ...(options.next ? { next_suggested: options.next } : {}),
    data,
  };
}

function failure(command: string, error: unknown): CliEnvelope {
  const message =
    error instanceof Error ? error.message : "Unknown CreatorCut error";
  return {
    schema_version: "creatorcut-cli/1.0",
    ok: false,
    command,
    requires_user_action: false,
    retryable: /timeout|temporar|503|network|fetch/iu.test(message),
    error: {
      code: error instanceof TypeError ? "invalid_input" : "operation_failed",
      message,
    },
  };
}

async function defaultAdapter(
  parsed: ParsedArguments,
  credentials: CredentialStore,
): Promise<CloudDirectorAdapter> {
  const apiKey = await credentials.getApiKey();
  if (!apiKey) {
    throw new Error(
      "CreatorCut is not authenticated; run creatorcut auth login",
    );
  }
  const keysetPath = requiredOption(
    parsed,
    "keyset",
    "CREATORCUT_DIRECTOR_KEYSET",
  );
  const recoveryRootsPath = requiredOption(
    parsed,
    "recovery-roots",
    "CREATORCUT_DIRECTOR_RECOVERY_ROOTS",
  );
  const minimumVersionValue = option(
    parsed,
    "minimum-keyset-version",
    "CREATORCUT_MINIMUM_KEYSET_VERSION",
  );
  const minimumVersion =
    minimumVersionValue === undefined
      ? undefined
      : Number.parseInt(minimumVersionValue, 10);
  if (
    minimumVersion !== undefined &&
    (!Number.isSafeInteger(minimumVersion) || minimumVersion <= 0)
  ) {
    throw new TypeError("CreatorCut minimum keyset version is invalid");
  }
  const trust = await loadVerifiedDirectorKeyset({
    keysetPath,
    recoveryRootsPath,
    ...(minimumVersion === undefined ? {} : { minimumVersion }),
  });
  return new CloudDirectorAdapter({
    endpoint: requiredOption(
      parsed,
      "endpoint",
      "CREATORCUT_DIRECTOR_ENDPOINT",
    ),
    apiKey,
    protocolBundleDigest: requiredOption(
      parsed,
      "protocol-digest",
      "CREATORCUT_PROTOCOL_BUNDLE_DIGEST",
    ),
    signedKeyset: trust.keyset,
    trustedRecoveryRoots: trust.roots,
    ...(minimumVersion === undefined
      ? {}
      : { minimumKeysetVersion: minimumVersion }),
  });
}

function releaseMetadataPath(parsed: ParsedArguments): string {
  return resolve(
    option(parsed, "install-metadata", "CREATORCUT_INSTALL_METADATA") ??
      join(
        process.env.CREATORCUT_INSTALL_DIR ??
          join(homedir(), ".local", "share", "creatorcut"),
        ".creatorcut-install.json",
      ),
  );
}

async function releaseTrust(parsed: ParsedArguments, minimumVersion?: number) {
  const configuredMinimum = option(
    parsed,
    "minimum-release-keyset-version",
    "CREATORCUT_MINIMUM_RELEASE_KEYSET_VERSION",
  );
  const parsedMinimum =
    configuredMinimum === undefined
      ? minimumVersion
      : Number.parseInt(configuredMinimum, 10);
  if (
    parsedMinimum !== undefined &&
    (!Number.isSafeInteger(parsedMinimum) || parsedMinimum <= 0)
  ) {
    throw new TypeError("CreatorCut minimum release keyset version is invalid");
  }
  return await loadVerifiedReleaseKeyset({
    keysetPath: requiredOption(
      parsed,
      "release-keyset",
      "CREATORCUT_RELEASE_KEYSET",
    ),
    recoveryRootsPath: requiredOption(
      parsed,
      "release-recovery-roots",
      "CREATORCUT_RELEASE_RECOVERY_ROOTS",
    ),
    ...(parsedMinimum === undefined ? {} : { minimumVersion: parsedMinimum }),
  });
}

async function fetchRelease(
  parsed: ParsedArguments,
  minimumKeysetVersion?: number,
) {
  const trust = await releaseTrust(parsed, minimumKeysetVersion);
  const manifest = await fetchVerifiedReleaseManifest({
    endpoint:
      option(parsed, "release-endpoint", "CREATORCUT_RELEASE_ENDPOINT") ??
      DEFAULT_RELEASE_ENDPOINT,
    trust,
  });
  return { manifest, keysetVersion: trust.keyset.keyset_version };
}

export async function executeCli(
  argv: string[],
  io: CliIo,
  dependencies: CliDependencies = {},
): Promise<CliEnvelope> {
  let commandName = "invalid";
  try {
    const parsed = parseArguments(argv);
    commandName = parsed.command.join(" ") || "help";
    const credentials =
      dependencies.credentials ??
      new KeychainCredentialStore({
        ...(process.env.CREATORCUT_KEYCHAIN_PATH
          ? { keychainPath: process.env.CREATORCUT_KEYCHAIN_PATH }
          : {}),
      });
    const projectDirectory = resolve(
      option(parsed, "project") ?? dependencies.cwd?.() ?? process.cwd(),
    );
    const adapter = () =>
      dependencies.adapterFactory?.() ?? defaultAdapter(parsed, credentials);

    if (commandName === "version") {
      return success(commandName, { version: CURRENT_CLIENT_VERSION });
    }

    if (commandName === "doctor") {
      const checks = {
        platform: process.platform,
        node: process.versions.node,
        keychain: process.platform === "darwin",
        authenticated: await credentials.hasApiKey(),
        project: await access(resolve(projectDirectory, ".creatorcut"))
          .then(() => true)
          .catch(() => false),
      };
      return success(commandName, checks, {
        next: checks.authenticated ? "project status" : "auth login",
      });
    }

    if (commandName === "upgrade-check") {
      const opened = await openCreatorCutProject(projectDirectory);
      const activeTasks = await findActiveProjectTasks(projectDirectory);
      return success(
        commandName,
        {
          compatible: true,
          update_safe: activeTasks.length === 0,
          project_schema_version: opened.project.schema_version,
          project_revision: opened.project.revision,
          active_tasks: activeTasks,
          preserved_state: [
            ".creatorcut/project.json",
            ".creatorcut/timeline.json",
            ".creatorcut/transcript.json",
            ".creatorcut/edit-brief.json",
            ".creatorcut/tasks",
            ".creatorcut/versions",
          ],
        },
        {
          revision: opened.project.revision,
          next:
            activeTasks.length === 0
              ? "update check"
              : activeTasks.some((task) => task.kind === "export")
                ? "export status"
                : "transcribe status",
        },
      );
    }

    if (commandName === "update check") {
      const metadataPath = releaseMetadataPath(parsed);
      const metadataExists = await access(metadataPath)
        .then(() => true)
        .catch(() => false);
      const metadata = metadataExists
        ? await readManagedInstallMetadata(metadataPath)
        : undefined;
      const release = await fetchRelease(
        parsed,
        metadata?.release_keyset_version,
      );
      const { manifest } = release;
      const check = releaseCheck(CURRENT_CLIENT_VERSION, manifest);
      return success(
        commandName,
        {
          ...check,
          managed: metadata !== undefined,
        },
        {
          next: check.status === "current" ? "project status" : "update apply",
        },
      );
    }

    if (commandName === "update apply") {
      const metadataPath = releaseMetadataPath(parsed);
      const metadata = await readManagedInstallMetadata(metadataPath);
      const projectExists = await access(
        resolve(projectDirectory, ".creatorcut"),
      )
        .then(() => true)
        .catch(() => false);
      if (projectExists) {
        const activeTasks = await findActiveProjectTasks(projectDirectory);
        if (activeTasks.length > 0) {
          return success(
            commandName,
            {
              status: "deferred",
              current_version: CURRENT_CLIENT_VERSION,
              active_tasks: activeTasks,
            },
            {
              next: activeTasks.some((task) => task.kind === "export")
                ? "export status"
                : "transcribe status",
            },
          );
        }
      }
      const release = await fetchRelease(
        parsed,
        metadata.release_keyset_version,
      );
      const { manifest } = release;
      const check = releaseCheck(CURRENT_CLIENT_VERSION, manifest);
      if (check.status === "current") {
        return success(commandName, check, { next: "project status" });
      }
      const updated = await applyManagedUpdate({
        manifest,
        releaseKeysetVersion: release.keysetVersion,
        metadataPath,
        ...(projectExists ? { projectDirectory } : {}),
      });
      return success(
        commandName,
        {
          status: "updated",
          from_version: CURRENT_CLIENT_VERSION,
          to_version: updated.version,
          git_commit: updated.git_commit,
        },
        { next: "doctor" },
      );
    }

    if (commandName === "auth login") {
      const apiKey = (await io.stdin()).trim();
      if (!apiKey) {
        throw new TypeError("AgentMesh API key is required on stdin");
      }
      await credentials.setApiKey(apiKey);
      return success(
        commandName,
        { stored_in: "macOS Keychain", authenticated: true },
        { next: "director context inspect" },
      );
    }
    if (commandName === "auth status") {
      return success(commandName, {
        authenticated: await credentials.hasApiKey(),
        storage: "macOS Keychain",
      });
    }
    if (commandName === "auth logout") {
      return success(commandName, {
        removed: await credentials.deleteApiKey(),
        remote_api_key_revoked: false,
      });
    }

    if (commandName === "project status") {
      const opened = await openCreatorCutProject(projectDirectory);
      const consent = await readDirectorConsent(opened);
      return success(
        commandName,
        {
          project_id: opened.project.project_id,
          name: opened.project.name,
          revision: opened.project.revision,
          language_mode: opened.transcript.language_mode,
          transcript_segments: opened.transcript.segments.length,
          director_consent: consent !== null,
        },
        {
          revision: opened.project.revision,
          next: consent ? "director start" : "director context inspect",
        },
      );
    }
    if (commandName === "project open") {
      const opened = await openCreatorCutProject(projectDirectory);
      return success(
        commandName,
        {
          project_id: opened.project.project_id,
          name: opened.project.name,
          revision: opened.project.revision,
          project_directory: opened.directory,
        },
        {
          revision: opened.project.revision,
          next:
            opened.transcript.segments.length > 0
              ? "director context inspect"
              : "transcribe start",
        },
      );
    }
    if (commandName === "project create" || commandName === "media import") {
      const sourcePath = requiredOption(parsed, "source");
      const projectName = option(parsed, "name");
      const ffmpegPath = option(parsed, "ffmpeg", "CREATORCUT_FFMPEG");
      const ffprobePath = option(parsed, "ffprobe", "CREATORCUT_FFPROBE");
      const imported = await importMedia({
        sourcePath,
        projectDirectory,
        ...(projectName ? { projectName } : {}),
        ...(ffmpegPath ? { ffmpegPath } : {}),
        ...(ffprobePath ? { ffprobePath } : {}),
      });
      return success(commandName, imported, {
        revision: 0,
        next: "transcribe start",
      });
    }

    if (commandName === "transcribe start") {
      const language = option(parsed, "language") ?? "auto";
      if (!["zh", "en", "mixed", "auto"].includes(language)) {
        throw new TypeError(
          "CreatorCut transcription language must be zh, en, mixed, or auto",
        );
      }
      const whisperPath = option(parsed, "whisper", "CREATORCUT_WHISPER");
      const ffmpegPath = option(parsed, "ffmpeg", "CREATORCUT_FFMPEG");
      const ffprobePath = option(parsed, "ffprobe", "CREATORCUT_FFPROBE");
      const task = await transcribeProject({
        projectDirectory,
        modelPath: requiredOption(parsed, "model", "CREATORCUT_WHISPER_MODEL"),
        languageMode: language as LanguageMode,
        ...(whisperPath ? { whisperPath } : {}),
        ...(ffmpegPath ? { ffmpegPath } : {}),
        ...(ffprobePath ? { ffprobePath } : {}),
        ...(option(parsed, "glossary")
          ? {
              glossary: option(parsed, "glossary")!
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
            }
          : {}),
      });
      if (task.state === "failed") {
        throw new Error(
          task.error?.message ?? "CreatorCut transcription failed",
        );
      }
      return success(commandName, task, {
        revision: task.base_revision,
        next:
          task.state === "completed"
            ? "director context inspect"
            : "transcribe status",
      });
    }
    if (commandName === "transcribe status") {
      const task = await readTranscriptionTask(projectDirectory);
      if (!task) throw new Error("CreatorCut transcription task is missing");
      return success(commandName, task, {
        revision: task.base_revision,
        next:
          task.state === "completed"
            ? "director context inspect"
            : task.state === "running"
              ? "transcribe status"
              : "transcribe resume",
      });
    }
    if (commandName === "transcribe resume") {
      const task = await resumeTranscriptionTask(projectDirectory);
      if (task.state === "failed") {
        throw new Error(
          task.error?.message ?? "CreatorCut transcription failed",
        );
      }
      return success(commandName, task, {
        revision: task.base_revision,
        next:
          task.state === "completed"
            ? "director context inspect"
            : "transcribe status",
      });
    }
    if (commandName === "transcribe cancel") {
      const task = await cancelTranscriptionTask(projectDirectory);
      return success(commandName, task, {
        revision: task.base_revision,
        next: "transcribe resume",
      });
    }
    if (commandName === "transcribe show") {
      const opened = await openCreatorCutProject(projectDirectory);
      return success(commandName, opened.transcript, {
        revision: opened.project.revision,
        next: "transcribe replace --file <corrected-transcript.json>",
      });
    }
    if (commandName === "transcribe replace") {
      const path = resolve(requiredOption(parsed, "file"));
      const value = JSON.parse(await readFile(path, "utf8")) as LocalTranscript;
      const opened = await replaceLocalTranscript(projectDirectory, value);
      return success(commandName, opened.transcript, {
        revision: opened.project.revision,
        next: "director context inspect",
      });
    }

    if (commandName === "director context inspect") {
      const opened = await openCreatorCutProject(projectDirectory);
      const context = buildDirectorContext(opened);
      return success(commandName, inspectDirectorContext(context), {
        revision: opened.project.revision,
        next: "director context consent --confirm-upload",
        requiresUserAction: true,
        userPrompt:
          "Review the complete DirectorContext above. It uploads transcript text and timing, but no original media, screenshots, absolute paths, or usernames.",
      });
    }
    if (commandName === "director context consent") {
      if (parsed.options.get("confirm-upload") !== true) {
        throw new TypeError(
          "Explicit --confirm-upload is required after context inspection",
        );
      }
      const opened = await openCreatorCutProject(projectDirectory);
      const context = buildDirectorContext(opened);
      const consent = await approveDirectorContext(opened, context);
      return success(commandName, consent, {
        revision: opened.project.revision,
        next: "director start",
      });
    }
    if (commandName === "director context revoke") {
      const opened = await openCreatorCutProject(projectDirectory);
      await revokeDirectorConsent(opened);
      return success(
        commandName,
        { revoked: true },
        {
          revision: opened.project.revision,
          next: "director delete",
        },
      );
    }

    if (commandName === "director start") {
      const value = await (await adapter()).start({ projectDirectory });
      return success(commandName, value, {
        revision: value.base_revision,
        next: value.current_card_envelope ? "cards get" : "edit quote",
      });
    }
    if (commandName === "director status") {
      const value = await (await adapter()).status(projectDirectory);
      return success(commandName, value, {
        next:
          value.kind === "session" &&
          value.value.current_card_envelope !== undefined
            ? "cards get"
            : value.kind === "session"
              ? "edit quote"
              : "edit status",
      });
    }
    if (commandName === "director delete") {
      await (await adapter()).deleteSession(projectDirectory);
      return success(commandName, { deleted: true });
    }

    if (commandName === "cards get") {
      const value = await (await adapter()).getCards({ projectDirectory });
      return success(
        commandName,
        {
          answer_set_id: answerSetIdForPresentation(
            value.presentation.presentation_digest,
          ),
          ...value,
        },
        {
          next: "cards submit",
          requiresUserAction: true,
          userPrompt: value.presentation.text_fallback,
        },
      );
    }
    if (commandName === "cards submit") {
      const submission = JSON.parse(await io.stdin()) as never;
      const value = await (
        await adapter()
      ).submitCards({
        projectDirectory,
        submission,
      });
      return success(commandName, value, {
        revision: value.base_revision,
        next: value.current_card_envelope ? "cards get" : "edit quote",
      });
    }

    if (commandName === "edit quote") {
      const quote = await (await adapter()).quote(projectDirectory);
      return success(commandName, quote, {
        next: "edit generate --confirmation-id <id>",
        requiresUserAction: true,
        userPrompt: `Confirm ${quote.payload.cost} credits for one immutable CreatorCut Director Generation.`,
      });
    }
    if (commandName === "edit generate") {
      const confirmationId = requiredOption(parsed, "confirmation-id");
      const generation = await (
        await adapter()
      ).generate({
        projectDirectory,
        confirmationId,
      });
      return success(commandName, generation, {
        next: "edit status",
      });
    }
    if (commandName === "edit status") {
      const value = await (await adapter()).status(projectDirectory);
      return success(commandName, value, {
        next:
          value.kind === "generation" && value.value.state === "awaiting_review"
            ? "edit review"
            : "edit status",
      });
    }
    if (commandName === "edit review") {
      const review = await (await adapter()).review(projectDirectory);
      return success(commandName, review, {
        next: "edit finalize",
        requiresUserAction: true,
        userPrompt:
          "Review every signed suggestion and submit a complete EditReviewDecisionSet on stdin.",
      });
    }
    if (commandName === "edit finalize") {
      const decisions = JSON.parse(await io.stdin()) as never;
      const manifest = await (
        await adapter()
      ).finalize(projectDirectory, {
        decisions,
      });
      return success(commandName, manifest, {
        next: "edit preview",
        requiresUserAction: true,
        userPrompt:
          "The signed Manifest is ready. Preview it locally before any apply.",
      });
    }
    if (commandName === "edit preview") {
      const director = await adapter();
      const manifest = await director.getVerifiedManifest(projectDirectory);
      const ffmpegPath = option(parsed, "ffmpeg", "CREATORCUT_FFMPEG");
      const ffprobePath = option(parsed, "ffprobe", "CREATORCUT_FFPROBE");
      const value = await previewSignedManifest(
        projectDirectory,
        manifest,
        option(parsed, "output"),
        {
          ...(ffmpegPath ? { ffmpegPath } : {}),
          ...(ffprobePath ? { ffprobePath } : {}),
        },
      );
      return success(commandName, value, {
        revision: manifest.base_revision,
        next: `edit apply --confirm-preview ${value.confirmation.confirmation_token}`,
        requiresUserAction: true,
        userPrompt:
          "Review the local preview. Apply only if its picture, original audio, subtitles, framing, filters, voice, and music match your intent.",
      });
    }
    if (commandName === "edit apply") {
      const director = await adapter();
      const manifest = await director.getVerifiedManifest(projectDirectory);
      const value = await applyPreviewedManifest(
        projectDirectory,
        manifest,
        requiredOption(parsed, "confirm-preview"),
      );
      return success(
        commandName,
        {
          project_id: value.opened.project.project_id,
          revision: value.opened.project.revision,
          manifest_digest: value.manifest_digest,
        },
        {
          revision: value.opened.project.revision,
          next: "export start --output <path.mp4>",
        },
      );
    }
    if (commandName === "edit undo") {
      const opened = await undoLocalRevision(projectDirectory);
      return success(
        commandName,
        {
          project_id: opened.project.project_id,
          revision: opened.project.revision,
        },
        {
          revision: opened.project.revision,
          next: "export start --output <path.mp4>",
        },
      );
    }
    if (commandName === "edit redo") {
      const opened = await redoLocalRevision(projectDirectory);
      return success(
        commandName,
        {
          project_id: opened.project.project_id,
          revision: opened.project.revision,
        },
        {
          revision: opened.project.revision,
          next: "export start --output <path.mp4>",
        },
      );
    }

    if (commandName === "export start") {
      const ffmpegPath = option(parsed, "ffmpeg", "CREATORCUT_FFMPEG");
      const ffprobePath = option(parsed, "ffprobe", "CREATORCUT_FFPROBE");
      const task = await startExportTask(
        projectDirectory,
        requiredOption(parsed, "output"),
        {
          overwrite: parsed.options.get("confirm-overwrite") === true,
          ...(ffmpegPath ? { ffmpegPath } : {}),
          ...(ffprobePath ? { ffprobePath } : {}),
        },
      );
      if (task.state === "failed") {
        throw new Error(task.error?.message ?? "CreatorCut export failed");
      }
      return success(commandName, task, {
        revision: task.base_revision,
        next: task.state === "completed" ? "export status" : "export status",
      });
    }
    if (commandName === "export status") {
      const task = await readExportTask(projectDirectory);
      if (!task) throw new Error("CreatorCut export task is missing");
      return success(commandName, task, {
        revision: task.base_revision,
        next:
          task.state === "completed"
            ? "project status"
            : task.state === "running"
              ? "export status"
              : "export resume",
      });
    }
    if (commandName === "export resume") {
      const task = await resumeExportTask(projectDirectory);
      if (task.state === "failed") {
        throw new Error(task.error?.message ?? "CreatorCut export failed");
      }
      return success(commandName, task, {
        revision: task.base_revision,
        next: "export status",
      });
    }
    if (commandName === "export cancel") {
      const task = await cancelExportTask(projectDirectory);
      return success(commandName, task, {
        revision: task.base_revision,
        next: "export resume",
      });
    }

    throw new TypeError(`Unknown CreatorCut command: ${commandName}`);
  } catch (error) {
    return failure(commandName, error);
  }
}
