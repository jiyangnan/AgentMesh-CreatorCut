import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";

import {
  createPlatformCredentialStore,
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
  adoptLegacyPublicProject,
  assertPublicStorageAuthority,
  buildDirectorContext,
  inspectDirectorContext,
  openCreatorCutProject,
  readDirectorConsent,
  redoLocalRevision,
  replaceLocalTranscript,
  revokeDirectorConsent,
  type LocalTranscript,
  undoLocalRevision,
  verifyMigratedVisualHandoff,
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

import { isApiKeyArgument } from "./next-process.js";
import type { CliEnvelope, CliIo } from "./types.js";

const CURRENT_CLIENT_VERSION = "0.3.0";
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

interface TranscriptionSuggestion {
  next: string;
  argv: string[];
  requiresUserAction: boolean;
  userPrompt?: string;
}

interface NextCommand {
  suggested: string;
  argv?: string[];
}

interface SuccessOptions {
  revision?: number;
  next?: string;
  nextArgv?: string[];
  requiresUserAction?: boolean;
  userPrompt?: string;
}

const LOCAL_DEPENDENCY_OPTIONS = [
  "ffmpeg",
  "ffprobe",
  "whisper",
  "model",
] as const;

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
    if (isApiKeyArgument(token)) {
      throw new TypeError(
        "CreatorCut never accepts API keys in command arguments",
      );
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
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
  if (value === true) {
    throw new TypeError(`CreatorCut requires a value for --${name}`);
  }
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

function localDependencyArguments(parsed: ParsedArguments): string[] {
  const argv: string[] = [];
  for (const name of LOCAL_DEPENDENCY_OPTIONS) {
    const value = parsed.options.get(name);
    if (typeof value === "string") argv.push(`--${name}`, value);
    else if (value === true) {
      throw new TypeError(`CreatorCut requires a value for --${name}`);
    }
  }
  return argv;
}

function executionToolPath(
  parsed: ParsedArguments,
  name: "ffmpeg" | "ffprobe" | "whisper",
  environmentName:
    "CREATORCUT_FFMPEG" | "CREATORCUT_FFPROBE" | "CREATORCUT_WHISPER",
): string | undefined {
  const value = option(parsed, name, environmentName);
  if (value === "") {
    throw new TypeError(
      `CreatorCut --${name} or ${environmentName} must be a non-empty executable path`,
    );
  }
  return value;
}

function projectNextCommand(
  parsed: ParsedArguments,
  projectDirectory: string,
  suggested: string,
  argv?: string[],
): NextCommand {
  if (typeof parsed.options.get("project") !== "string") {
    return { suggested, ...(argv ? { argv } : {}) };
  }
  return {
    suggested: `${suggested} --project PROJECT_DIRECTORY`,
    ...(argv ? { argv: [...argv, "--project", projectDirectory] } : {}),
  };
}

function baseSuccess<T>(
  command: string,
  data: T,
  options: SuccessOptions = {},
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
    ...(options.nextArgv ? { next_argv: options.nextArgv } : {}),
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

async function available(path: string | undefined, executable = true) {
  if (!path) return false;
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, executable ? constants.X_OK : constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function executableCandidates(command: string): string[] {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return [resolve(command)];
  }

  const extensions =
    process.platform === "win32" && extname(command) === ""
      ? ["", ".COM", ".EXE"]
      : [""];
  const candidates = new Set<string>();
  for (const rawEntry of (process.env.PATH ?? "").split(delimiter)) {
    const unquoted = rawEntry.replace(/^"(.*)"$/u, "$1");
    const entry = unquoted || ".";
    for (const extension of extensions) {
      candidates.add(resolve(entry, `${command}${extension}`));
    }
  }
  return [...candidates];
}

async function inspectExecutable(
  configuredPath: string | undefined,
  defaultCommand: string,
) {
  if (configuredPath === "") {
    return { path: "", ready: false };
  }
  const requested = configuredPath ?? defaultCommand;
  for (const candidate of executableCandidates(requested)) {
    if (process.platform === "win32") {
      const extension = extname(candidate).toUpperCase();
      if (extension && extension !== ".COM" && extension !== ".EXE") {
        continue;
      }
    }
    if (await available(candidate)) {
      return { path: candidate, ready: true };
    }
  }
  return {
    path: configuredPath ?? null,
    ready: false,
  };
}

async function inspectLocalDependencies(parsed: ParsedArguments) {
  const ffmpegPath = option(parsed, "ffmpeg", "CREATORCUT_FFMPEG");
  const ffprobePath = option(parsed, "ffprobe", "CREATORCUT_FFPROBE");
  const whisperPath = option(parsed, "whisper", "CREATORCUT_WHISPER");
  const modelPath = option(parsed, "model", "CREATORCUT_WHISPER_MODEL");
  const [ffmpeg, ffprobe, whisper] = await Promise.all([
    inspectExecutable(ffmpegPath, "ffmpeg"),
    inspectExecutable(ffprobePath, "ffprobe"),
    inspectExecutable(whisperPath, "whisper-cli"),
  ]);
  return {
    node: {
      path: process.execPath,
      version: process.versions.node,
      ready: process.versions.node.split(".")[0] === "24",
    },
    ffmpeg,
    ffprobe,
    whisper,
    whisper_model: {
      path: modelPath ?? null,
      ready: await available(modelPath, false),
    },
  };
}

async function transcriptionSuggestion(
  parsed: ParsedArguments,
  dependencyArguments: string[],
): Promise<TranscriptionSuggestion> {
  const dependencies = await inspectLocalDependencies(parsed);
  const missing = Object.entries(dependencies)
    .filter(([, dependency]) => !dependency.ready)
    .map(([name]) =>
      name === "node"
        ? "Node.js 24"
        : name === "whisper"
          ? "whisper-cli"
          : name === "whisper_model"
            ? "CREATORCUT_WHISPER_MODEL"
            : name,
    );
  if (missing.length === 0) {
    return {
      next: "transcribe start --language auto",
      argv: [
        "transcribe",
        "start",
        "--language",
        "auto",
        ...dependencyArguments,
      ],
      requiresUserAction: false,
    };
  }
  return {
    next: "doctor",
    argv: ["doctor", ...dependencyArguments],
    requiresUserAction: true,
    userPrompt: `CreatorCut local transcription dependencies are incomplete (${missing.join(
      ", ",
    )}). Run creatorcut doctor, re-run the official managed installer or repair the listed local configuration, then resume this project.`,
  };
}

async function inspectOnboardingState(
  parsed: ParsedArguments,
  projectDirectory: string,
  credentials: CredentialStore,
) {
  const localDependencies = await inspectLocalDependencies(parsed);
  const directorPaths = {
    keyset: process.env.CREATORCUT_DIRECTOR_KEYSET,
    recovery_roots: process.env.CREATORCUT_DIRECTOR_RECOVERY_ROOTS,
  };
  const directorConfiguration = {
    endpoint: process.env.CREATORCUT_DIRECTOR_ENDPOINT ?? null,
    protocol_bundle_digest:
      process.env.CREATORCUT_PROTOCOL_BUNDLE_DIGEST ?? null,
    keyset: {
      path: directorPaths.keyset ?? null,
      ready: await available(directorPaths.keyset, false),
    },
    recovery_roots: {
      path: directorPaths.recovery_roots ?? null,
      ready: await available(directorPaths.recovery_roots, false),
    },
  };
  const projectReady = await access(resolve(projectDirectory, ".creatorcut"))
    .then(() => true)
    .catch(() => false);
  const protocolDigestReady = /^sha256:[a-f0-9]{64}$/u.test(
    directorConfiguration.protocol_bundle_digest ?? "",
  );
  const directorConfigurationReady =
    Boolean(directorConfiguration.endpoint) &&
    protocolDigestReady &&
    directorConfiguration.keyset.ready &&
    directorConfiguration.recovery_roots.ready;

  return {
    product: "AgentMesh-CreatorCut",
    platform: process.platform,
    node: process.versions.node,
    credential_storage: credentials.storage,
    dependencies: localDependencies,
    dependencies_ready: Object.values(localDependencies).every(
      (dependency) => dependency.ready,
    ),
    director_configuration: directorConfiguration,
    director_configuration_ready: directorConfigurationReady,
    authenticated: await credentials.hasApiKey(),
    project: projectReady,
  };
}

export async function executeCli(
  argv: string[],
  io: CliIo,
  dependencies: CliDependencies = {},
): Promise<CliEnvelope> {
  let commandName = "invalid";
  try {
    const normalizedArgv =
      argv.length === 1 && argv[0] === "--version" ? ["version"] : argv;
    const parsed = parseArguments(normalizedArgv);
    commandName = parsed.command.join(" ") || "help";
    if (commandName === "project adopt-public") {
      if (parsed.options.get("confirm-local") !== true) {
        throw new TypeError(
          "Explicit --confirm-local is required; it confirms all v0.2.1 CreatorCut processes are stopped and no preview, Director, export, or transcription work is in progress",
        );
      }
    }
    if (
      commandName === "project migrate-internal" ||
      commandName === "project rollback-internal"
    ) {
      throw new TypeError(
        "CreatorCut internal storage migration and rollback are disabled: the production native whole-tree swap/WAL gate is not complete",
      );
    }
    const dependencyArguments = localDependencyArguments(parsed);
    if (commandName === "project adopt-public") {
      const projectDirectory = resolve(
        option(parsed, "project") ?? dependencies.cwd?.() ?? process.cwd(),
      );
      const next = projectNextCommand(
        parsed,
        projectDirectory,
        "project status",
        ["project", "status"],
      );
      const marker = await adoptLegacyPublicProject(projectDirectory, {
        confirmLocal: true,
      });
      return baseSuccess(commandName, marker, {
        revision: marker.current_revision,
        next: next.suggested,
        ...(next.argv ? { nextArgv: next.argv } : {}),
      });
    }
    const credentials =
      dependencies.credentials ?? createPlatformCredentialStore();
    const projectDirectory = resolve(
      option(parsed, "project") ?? dependencies.cwd?.() ?? process.cwd(),
    );
    const success = <T>(
      command: string,
      data: T,
      options: SuccessOptions = {},
    ): CliEnvelope<T> => {
      if (!options.next) return baseSuccess(command, data, options);
      if (
        options.next.includes("PROJECT_DIRECTORY") ||
        options.nextArgv?.includes("--project") ||
        options.next.includes("--project")
      ) {
        return baseSuccess(command, data, options);
      }
      const inferredArgv = /[<>\r\n]/u.test(options.next)
        ? undefined
        : options.next.split(/\s+/u).filter(Boolean);
      const scoped = projectNextCommand(
        parsed,
        projectDirectory,
        options.next,
        options.nextArgv ?? inferredArgv,
      );
      return baseSuccess(command, data, {
        ...options,
        next: scoped.suggested,
        ...(scoped.argv ? { nextArgv: scoped.argv } : {}),
      });
    };
    const adapter = () =>
      dependencies.adapterFactory?.() ?? defaultAdapter(parsed, credentials);

    if (commandName === "version") {
      return success(commandName, { version: CURRENT_CLIENT_VERSION });
    }

    if (commandName === "doctor") {
      const checks = await inspectOnboardingState(
        parsed,
        projectDirectory,
        credentials,
      );
      const next = projectNextCommand(parsed, projectDirectory, "onboard", [
        "onboard",
        ...dependencyArguments,
      ]);
      return success(commandName, checks, {
        next: next.suggested,
        ...(next.argv ? { nextArgv: next.argv } : {}),
      });
    }

    if (commandName === "onboard") {
      const checks = await inspectOnboardingState(
        parsed,
        projectDirectory,
        credentials,
      );

      if (!checks.dependencies_ready) {
        const next = projectNextCommand(parsed, projectDirectory, "doctor", [
          "doctor",
          ...dependencyArguments,
        ]);
        return success(
          commandName,
          {
            stage: "repair_local_environment",
            complete: false,
            checks,
          },
          {
            next: next.suggested,
            ...(next.argv ? { nextArgv: next.argv } : {}),
            requiresUserAction: true,
            userPrompt:
              "CreatorCut local media dependencies are incomplete. Re-run the official managed installer, then run creatorcut onboard again.",
          },
        );
      }
      if (!checks.authenticated) {
        const next = projectNextCommand(
          parsed,
          projectDirectory,
          "auth login",
          ["auth", "login", ...dependencyArguments],
        );
        return success(
          commandName,
          {
            stage: "authenticate",
            complete: false,
            checks,
          },
          {
            next: next.suggested,
            ...(next.argv ? { nextArgv: next.argv } : {}),
            requiresUserAction: true,
            userPrompt:
              "Open https://agentmesh360.com/app/#account, create or copy an AgentMesh API Key, then run creatorcut auth login and paste the key through stdin. Never put the key in command arguments, prompts, logs, or shell history.",
          },
        );
      }
      if (!checks.project) {
        return success(
          commandName,
          {
            stage: "import_media",
            complete: false,
            checks,
          },
          {
            next: "media import --source <recording.mov> --project <project.creatorcut>",
            requiresUserAction: true,
            userPrompt:
              "Choose one recorded talking-head or product-demo file and a new local CreatorCut project folder. The source media remains on this device.",
          },
        );
      }

      const opened = await openCreatorCutProject(projectDirectory);
      const consent = await readDirectorConsent(opened);
      const next = projectNextCommand(
        parsed,
        projectDirectory,
        opened.transcript.segments.length === 0
          ? "transcribe start --language auto"
          : !checks.director_configuration_ready
            ? "doctor"
            : consent
              ? "director start"
              : "director context inspect",
        opened.transcript.segments.length === 0
          ? [
              "transcribe",
              "start",
              "--language",
              "auto",
              ...dependencyArguments,
            ]
          : !checks.director_configuration_ready
            ? ["doctor", ...dependencyArguments]
            : consent
              ? ["director", "start"]
              : ["director", "context", "inspect"],
      );
      const stage =
        opened.transcript.segments.length === 0
          ? "transcribe"
          : !checks.director_configuration_ready
            ? "repair_director_configuration"
            : consent
              ? "start_director"
              : "inspect_director_context";
      return success(
        commandName,
        {
          stage,
          complete: false,
          checks,
          project: {
            project_id: opened.project.project_id,
            name: opened.project.name,
            revision: opened.project.revision,
            transcript_segments: opened.transcript.segments.length,
            director_consent: consent !== null,
          },
        },
        {
          revision: opened.project.revision,
          next: next.suggested,
          ...(next.argv ? { nextArgv: next.argv } : {}),
          requiresUserAction:
            stage === "repair_director_configuration" ||
            stage === "inspect_director_context",
          ...(stage === "repair_director_configuration"
            ? {
                userPrompt:
                  "CreatorCut local media is ready, but the signed production Director trust configuration is missing. Re-run the official managed installer, then resume this project with creatorcut onboard --project <project>.",
              }
            : stage === "inspect_director_context"
              ? {
                  userPrompt:
                    "Inspect the complete local DirectorContext and request explicit project-level approval before uploading the structured context. Source media is not uploaded.",
                }
              : {}),
        },
      );
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
        { stored_in: credentials.storage, authenticated: true },
        {
          next: "onboard",
          nextArgv: ["onboard", ...dependencyArguments],
        },
      );
    }
    if (commandName === "auth status") {
      const authenticated = await credentials.hasApiKey();
      return success(
        commandName,
        {
          authenticated,
          storage: credentials.storage,
        },
        authenticated
          ? {
              next: "onboard",
              nextArgv: ["onboard", ...dependencyArguments],
            }
          : {
              next: "auth login",
              nextArgv: ["auth", "login", ...dependencyArguments],
              requiresUserAction: true,
              userPrompt:
                "No AgentMesh API key is stored. Run creatorcut auth login in a private user-controlled terminal, then resume through auth status with the same project scope.",
            },
      );
    }
    if (commandName === "auth logout") {
      return success(commandName, {
        removed: await credentials.deleteApiKey(),
        remote_api_key_revoked: false,
      });
    }

    if (commandName === "project status") {
      const opened = await openCreatorCutProject(projectDirectory);
      const authority = await assertPublicStorageAuthority(
        opened.creatorcutDirectory,
      );
      const consent = await readDirectorConsent(opened);
      const migratedHandoff =
        authority.source_format ===
        "creatorcut-internal-project-store/1.0-alpha"
          ? await verifyMigratedVisualHandoff(projectDirectory)
          : null;
      const migratedVisualHandoff =
        migratedHandoff?.visual_handoff_present === true
          ? migratedHandoff
          : null;
      const transcription =
        !migratedVisualHandoff && opened.transcript.segments.length === 0
          ? await transcriptionSuggestion(parsed, dependencyArguments)
          : null;
      const next = projectNextCommand(
        parsed,
        projectDirectory,
        migratedVisualHandoff
          ? migratedVisualHandoff.next === "edit_redo"
            ? "edit redo"
            : "handoff verify"
          : transcription
            ? transcription.next
            : consent
              ? "director start"
              : "director context inspect",
        migratedVisualHandoff
          ? migratedVisualHandoff.next === "edit_redo"
            ? ["edit", "redo"]
            : ["handoff", "verify"]
          : transcription
            ? transcription.argv
            : consent
              ? ["director", "start"]
              : ["director", "context", "inspect"],
      );
      return success(
        commandName,
        {
          project_id: opened.project.project_id,
          name: opened.project.name,
          revision: opened.project.revision,
          language_mode: opened.transcript.language_mode,
          transcript_segments: opened.transcript.segments.length,
          director_consent: consent !== null,
          storage_authority: authority?.authority ?? "public-runtime",
          visual_composition_id: opened.visualComposition?.composition_id,
          visual_composition_state: opened.visualComposition?.state,
          visual_handoff_present:
            migratedHandoff?.visual_handoff_present ?? false,
          handoff_visual_state: migratedVisualHandoff?.visual_state,
        },
        {
          revision: opened.project.revision,
          next: next.suggested,
          ...(next.argv ? { nextArgv: next.argv } : {}),
          ...(transcription
            ? {
                requiresUserAction: transcription.requiresUserAction,
                ...(transcription.userPrompt
                  ? { userPrompt: transcription.userPrompt }
                  : {}),
              }
            : {}),
        },
      );
    }
    if (commandName === "project open") {
      const opened = await openCreatorCutProject(projectDirectory);
      const transcription =
        opened.transcript.segments.length === 0
          ? await transcriptionSuggestion(parsed, dependencyArguments)
          : null;
      const next = projectNextCommand(
        parsed,
        projectDirectory,
        transcription?.next ?? "director context inspect",
        transcription?.argv ?? ["director", "context", "inspect"],
      );
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
          next: next.suggested,
          ...(next.argv ? { nextArgv: next.argv } : {}),
          ...(transcription
            ? {
                requiresUserAction: transcription.requiresUserAction,
                ...(transcription.userPrompt
                  ? { userPrompt: transcription.userPrompt }
                  : {}),
              }
            : {}),
        },
      );
    }
    if (commandName === "project create" || commandName === "media import") {
      const sourcePath = requiredOption(parsed, "source");
      const projectName = option(parsed, "name");
      const ffmpegPath = executionToolPath(
        parsed,
        "ffmpeg",
        "CREATORCUT_FFMPEG",
      );
      const ffprobePath = executionToolPath(
        parsed,
        "ffprobe",
        "CREATORCUT_FFPROBE",
      );
      const imported = await importMedia({
        sourcePath,
        projectDirectory,
        ...(projectName ? { projectName } : {}),
        ...(ffmpegPath ? { ffmpegPath } : {}),
        ...(ffprobePath ? { ffprobePath } : {}),
      });
      const transcription = await transcriptionSuggestion(
        parsed,
        dependencyArguments,
      );
      const next = projectNextCommand(
        parsed,
        projectDirectory,
        transcription.next,
        transcription.argv,
      );
      return success(commandName, imported, {
        revision: 0,
        next: next.suggested,
        ...(next.argv ? { nextArgv: next.argv } : {}),
        requiresUserAction: transcription.requiresUserAction,
        ...(transcription.userPrompt
          ? { userPrompt: transcription.userPrompt }
          : {}),
      });
    }

    if (commandName === "transcribe start") {
      const language = option(parsed, "language") ?? "auto";
      if (!["zh", "en", "mixed", "auto"].includes(language)) {
        throw new TypeError(
          "CreatorCut transcription language must be zh, en, mixed, or auto",
        );
      }
      const whisperPath = executionToolPath(
        parsed,
        "whisper",
        "CREATORCUT_WHISPER",
      );
      const ffmpegPath = executionToolPath(
        parsed,
        "ffmpeg",
        "CREATORCUT_FFMPEG",
      );
      const ffprobePath = executionToolPath(
        parsed,
        "ffprobe",
        "CREATORCUT_FFPROBE",
      );
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
      if (option(parsed, "output")) {
        throw new Error(
          "CreatorCut edit preview uses a managed project preview path; --output is not accepted",
        );
      }
      const ffmpegPath = executionToolPath(
        parsed,
        "ffmpeg",
        "CREATORCUT_FFMPEG",
      );
      const ffprobePath = executionToolPath(
        parsed,
        "ffprobe",
        "CREATORCUT_FFPROBE",
      );
      const director = await adapter();
      const manifest = await director.getVerifiedManifest(projectDirectory);
      const value = await previewSignedManifest(projectDirectory, manifest, {
        ...(ffmpegPath ? { ffmpegPath } : {}),
        ...(ffprobePath ? { ffprobePath } : {}),
      });
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
      const authority = await assertPublicStorageAuthority(
        opened.creatorcutDirectory,
      );
      const migratedHandoff =
        authority.source_format ===
        "creatorcut-internal-project-store/1.0-alpha"
          ? await verifyMigratedVisualHandoff(projectDirectory)
          : null;
      return success(
        commandName,
        {
          project_id: opened.project.project_id,
          revision: opened.project.revision,
          visual_composition_id: opened.visualComposition?.composition_id,
          visual_composition_state: opened.visualComposition?.state,
        },
        {
          revision: opened.project.revision,
          next:
            migratedHandoff?.visual_handoff_present === true
              ? "handoff verify"
              : migratedHandoff
                ? "project status"
                : "export plan",
        },
      );
    }
    if (commandName === "edit redo") {
      const opened = await redoLocalRevision(projectDirectory);
      const authority = await assertPublicStorageAuthority(
        opened.creatorcutDirectory,
      );
      const migratedHandoff =
        authority.source_format ===
        "creatorcut-internal-project-store/1.0-alpha"
          ? await verifyMigratedVisualHandoff(projectDirectory)
          : null;
      return success(
        commandName,
        {
          project_id: opened.project.project_id,
          revision: opened.project.revision,
          visual_composition_id: opened.visualComposition?.composition_id,
          visual_composition_state: opened.visualComposition?.state,
        },
        {
          revision: opened.project.revision,
          next:
            migratedHandoff?.visual_handoff_present === true
              ? "handoff verify"
              : migratedHandoff
                ? "project status"
                : "export plan",
        },
      );
    }

    if (commandName === "handoff verify") {
      const verification = await verifyMigratedVisualHandoff(projectDirectory);
      if (!verification.visual_handoff_present) {
        return success(
          commandName,
          {
            ...verification,
            storage_authority: "public-runtime",
            director_context_uploaded: false,
            director_consent_created: false,
          },
          {
            revision: verification.current_revision,
            next: "project status",
          },
        );
      }
      const next =
        verification.next === "export_plan"
          ? "export plan"
          : verification.next === "edit_redo"
            ? "edit redo"
            : undefined;
      return success(
        commandName,
        {
          ...verification,
          storage_authority: "public-runtime",
          director_context_uploaded: false,
          director_consent_created: false,
          visual_render_supported: false,
        },
        {
          revision: verification.current_revision,
          ...(next ? { next } : {}),
          ...(verification.next === "handoff_repair"
            ? {
                requiresUserAction: true,
                userPrompt:
                  "The migrated visual composition needs a verified rebase before it can be planned for export.",
              }
            : {}),
        },
      );
    }
    if (commandName === "export plan") {
      const opened = await openCreatorCutProject(projectDirectory);
      const authority = await assertPublicStorageAuthority(
        opened.creatorcutDirectory,
      );
      const migratedHandoff =
        authority.source_format ===
        "creatorcut-internal-project-store/1.0-alpha"
          ? await verifyMigratedVisualHandoff(projectDirectory)
          : null;
      const visualBlocked =
        opened.visualComposition !== undefined ||
        migratedHandoff?.visual_handoff_present === true;
      return success(
        commandName,
        {
          project_id: opened.project.project_id,
          base_revision: opened.project.revision,
          visual_composition_id: opened.visualComposition?.composition_id,
          visual_composition_state: opened.visualComposition?.state,
          ready: !visualBlocked,
          visual_render_supported: false,
          blocked_reason: visualBlocked
            ? "The public renderer cannot yet materialize migrated visual events; exporting would omit the approved visual composition."
            : null,
          writes_media: false,
          starts_export_task: false,
          output_requested: option(parsed, "output") ?? null,
        },
        {
          revision: opened.project.revision,
          next: visualBlocked
            ? "handoff verify"
            : "export start --output <path.mp4>",
        },
      );
    }
    if (commandName === "export start") {
      const ffmpegPath = executionToolPath(
        parsed,
        "ffmpeg",
        "CREATORCUT_FFMPEG",
      );
      const ffprobePath = executionToolPath(
        parsed,
        "ffprobe",
        "CREATORCUT_FFPROBE",
      );
      const opened = await openCreatorCutProject(projectDirectory);
      const authority = await assertPublicStorageAuthority(
        opened.creatorcutDirectory,
      );
      const migratedHandoff =
        authority.source_format ===
        "creatorcut-internal-project-store/1.0-alpha"
          ? await verifyMigratedVisualHandoff(projectDirectory)
          : null;
      if (
        opened.visualComposition ||
        migratedHandoff?.visual_handoff_present === true
      ) {
        throw new Error(
          "Public export is blocked because migrated visual events are not yet supported by the renderer",
        );
      }
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
      const opened = await openCreatorCutProject(projectDirectory);
      const authority = await assertPublicStorageAuthority(
        opened.creatorcutDirectory,
      );
      if (
        authority.source_format ===
          "creatorcut-internal-project-store/1.0-alpha" &&
        (await verifyMigratedVisualHandoff(projectDirectory))
          .visual_handoff_present
      ) {
        throw new Error(
          "Public export is blocked because migrated visual events are not yet supported by the renderer",
        );
      }
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
