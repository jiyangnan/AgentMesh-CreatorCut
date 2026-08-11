import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  OPENCLAW_BRIDGE_ARGUMENT,
  OPENCLAW_BRIDGE_COMMAND,
  OPENCLAW_JSON_READY_MARKER,
  OPENCLAW_REQUEST_ENVIRONMENT,
  readOpenClawJsonLine,
  resolveOpenClawBridgeInvocation,
  withNextProcess,
} from "../src/next-process.js";
import type { CliEnvelope } from "../src/types.js";

const execFileAsync = promisify(execFile);

describe("CreatorCut shell-free next process", () => {
  it("preserves every argument through a direct Node process on every platform", async () => {
    const directory = await mkdtemp(join(tmpdir(), "creatorcut next-process "));
    const mainModule = join(directory, "direct process probe.mjs");
    const project = join(
      directory,
      "$(not-a-shell)-%NOT_EXPANDED%-project.creatorcut",
    );
    const managedPath = join(directory, "managed bin");
    const managedModel = join(directory, "managed model.bin");
    const managedEnvironment = {
      PATH: managedPath,
      CREATORCUT_INSTALL_DIR: directory,
      CREATORCUT_INSTALL_METADATA: join(directory, ".creatorcut-install.json"),
      CREATORCUT_RELEASE_ENDPOINT: "https://release.invalid/v1",
      CREATORCUT_RELEASE_KEYSET: join(
        directory,
        "release",
        "release-keyset.json",
      ),
      CREATORCUT_RELEASE_RECOVERY_ROOTS: join(
        directory,
        "release",
        "recovery-roots.json",
      ),
      CREATORCUT_MINIMUM_RELEASE_KEYSET_VERSION: "1",
      CREATORCUT_DIRECTOR_ENDPOINT: "https://director.invalid/v1",
      CREATORCUT_DIRECTOR_KEYSET: join(
        directory,
        "release",
        "director-keyset.json",
      ),
      CREATORCUT_DIRECTOR_RECOVERY_ROOTS: join(
        directory,
        "release",
        "director-recovery-roots.json",
      ),
      CREATORCUT_MINIMUM_KEYSET_VERSION: "1",
      CREATORCUT_PROTOCOL_BUNDLE_DIGEST: `sha256:${"a".repeat(64)}`,
      CREATORCUT_FFMPEG: join(directory, "ffmpeg"),
      CREATORCUT_FFPROBE: join(directory, "ffprobe"),
      CREATORCUT_WHISPER: join(directory, "whisper-cli"),
      CREATORCUT_WHISPER_MODEL: managedModel,
      CREATORCUT_KEYCHAIN_PATH: join(directory, "test.keychain-db"),
      CREATORCUT_DPAPI_PATH: join(directory, "api-key.dpapi"),
    };
    try {
      await writeFile(
        mainModule,
        `process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  environment: {
    path: process.env.PATH,
    install: process.env.CREATORCUT_INSTALL_DIR,
    model: process.env.CREATORCUT_WHISPER_MODEL,
    api_key: process.env.CREATORCUT_API_KEY ?? null,
    unrelated: process.env.UNRELATED_PRIVATE_VALUE ?? null,
  },
}));\n`,
      );
      const envelope: CliEnvelope = {
        schema_version: "creatorcut-cli/1.0",
        ok: true,
        command: "probe",
        requires_user_action: false,
        retryable: false,
        next_suggested: "project status --project PROJECT_DIRECTORY",
        next_argv: ["project", "status", "--project", project],
        data: {},
      };
      const result = withNextProcess(envelope, {
        executable: process.execPath,
        mainModule,
        cwd: directory,
        environment: {
          ...managedEnvironment,
          CREATORCUT_API_KEY: "must-not-leak",
          UNRELATED_PRIVATE_VALUE: "must-not-leak",
        },
      });

      expect(result.next_process).toEqual({
        executable: process.execPath,
        argv: [mainModule, "project", "status", "--project", project],
        cwd: directory,
        env_overrides: managedEnvironment,
        shell: false,
      });
      expect(result.next_openclaw).toEqual({
        exec: {
          command: OPENCLAW_BRIDGE_COMMAND,
          workdir: directory,
          env: {
            [OPENCLAW_REQUEST_ENVIRONMENT]: JSON.stringify({
              argv: ["project", "status", "--project", project],
              stdin_mode: "none",
            }),
          },
          pty: false,
          background: false,
        },
        input: { mode: "none" },
      });
      const executed = await execFileAsync(
        result.next_process!.executable,
        result.next_process!.argv,
        {
          cwd: result.next_process!.cwd,
          encoding: "utf8",
          env: {
            ...result.next_process!.env_overrides,
            HOME: directory,
            ...(process.env.SystemRoot
              ? { SystemRoot: process.env.SystemRoot }
              : {}),
          },
          shell: false,
          windowsHide: true,
        },
      );
      expect(executed.stderr).toBe("");
      expect(JSON.parse(executed.stdout)).toEqual({
        argv: ["project", "status", "--project", project],
        cwd: await realpath(directory),
        environment: {
          path: managedPath,
          install: directory,
          model: managedModel,
          api_key: null,
          unrelated: null,
        },
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("emits the fixed OpenClaw PTY contract only for non-secret JSON input", () => {
    const syntheticCwd = process.cwd();
    const syntheticMain = join(syntheticCwd, "synthetic-main.js");
    const base: CliEnvelope = {
      schema_version: "creatorcut-cli/1.0",
      ok: true,
      command: "probe",
      requires_user_action: true,
      retryable: false,
      next_suggested: "cards submit",
      next_argv: ["cards", "submit", "--project", "/synthetic/project"],
    };
    const cards = withNextProcess(base, {
      executable: process.execPath,
      mainModule: syntheticMain,
      cwd: syntheticCwd,
      environment: {},
    });
    expect(cards.next_openclaw).toEqual({
      exec: {
        command: OPENCLAW_BRIDGE_COMMAND,
        workdir: syntheticCwd,
        env: {
          [OPENCLAW_REQUEST_ENVIRONMENT]: JSON.stringify({
            argv: base.next_argv,
            stdin_mode: "json-line-v1",
          }),
        },
        pty: true,
        background: true,
      },
      input: {
        mode: "json-line-v1",
        ready_marker: OPENCLAW_JSON_READY_MARKER,
        maximum_utf8_bytes: 4 * 1024 * 1024,
      },
    });

    const login = withNextProcess(
      { ...base, next_suggested: "auth login", next_argv: ["auth", "login"] },
      {
        executable: process.execPath,
        mainModule: syntheticMain,
        cwd: syntheticCwd,
        environment: {},
      },
    );
    expect(login.next_openclaw).toBeUndefined();
  });

  it("validates and consumes bounded OpenClaw bridge data without interpolation", () => {
    const hostileProject =
      "/tmp/$(not-a-shell)-`still-not-a-shell`-%NOT_EXPANDED%.creatorcut";
    const environment = {
      [OPENCLAW_REQUEST_ENVIRONMENT]: JSON.stringify({
        argv: ["project", "status", "--project", hostileProject],
        stdin_mode: "none",
      }),
    };
    expect(
      resolveOpenClawBridgeInvocation([OPENCLAW_BRIDGE_ARGUMENT], environment),
    ).toEqual({
      argv: ["project", "status", "--project", hostileProject],
      stdinMode: "none",
    });
    expect(environment).toEqual({});

    expect(() =>
      resolveOpenClawBridgeInvocation([OPENCLAW_BRIDGE_ARGUMENT], {
        [OPENCLAW_REQUEST_ENVIRONMENT]: JSON.stringify({
          argv: ["--project", hostileProject, "auth", "login"],
          stdin_mode: "none",
        }),
      }),
    ).toThrow(/never transports API keys/iu);
    expect(() =>
      resolveOpenClawBridgeInvocation([OPENCLAW_BRIDGE_ARGUMENT], {
        [OPENCLAW_REQUEST_ENVIRONMENT]: JSON.stringify({
          argv: ["cards", "submit"],
          stdin_mode: "none",
        }),
      }),
    ).toThrow(/requires json-line-v1/iu);
    expect(() =>
      resolveOpenClawBridgeInvocation(["version"], {
        [OPENCLAW_REQUEST_ENVIRONMENT]: JSON.stringify({
          argv: ["version"],
          stdin_mode: "none",
        }),
      }),
    ).toThrow(/requires the fixed bridge command/iu);

    const malformed = { [OPENCLAW_REQUEST_ENVIRONMENT]: "{" };
    expect(() =>
      resolveOpenClawBridgeInvocation([OPENCLAW_BRIDGE_ARGUMENT], malformed),
    ).toThrow(/valid JSON/iu);
    expect(malformed).toEqual({});
    expect(() =>
      resolveOpenClawBridgeInvocation([OPENCLAW_BRIDGE_ARGUMENT, "extra"], {
        [OPENCLAW_REQUEST_ENVIRONMENT]: JSON.stringify({
          argv: ["version"],
          stdin_mode: "none",
        }),
      }),
    ).toThrow(/fixed bridge command/iu);
    expect(() =>
      resolveOpenClawBridgeInvocation([OPENCLAW_BRIDGE_ARGUMENT], {
        [OPENCLAW_REQUEST_ENVIRONMENT]: JSON.stringify({
          argv: [OPENCLAW_BRIDGE_ARGUMENT],
          stdin_mode: "none",
        }),
      }),
    ).toThrow(/recursion/iu);
    expect(() =>
      resolveOpenClawBridgeInvocation([OPENCLAW_BRIDGE_ARGUMENT], {
        [OPENCLAW_REQUEST_ENVIRONMENT]: JSON.stringify({
          argv: ["auth", "login", "--key", "never"],
          stdin_mode: "none",
        }),
      }),
    ).toThrow(/API keys/iu);
    const equalsSecret = "am_equals_secret";
    const equalsEnvironment = {
      [OPENCLAW_REQUEST_ENVIRONMENT]: JSON.stringify({
        argv: ["version", `--key=${equalsSecret}`],
        stdin_mode: "none",
      }),
    };
    let equalsError: unknown;
    try {
      resolveOpenClawBridgeInvocation(
        [OPENCLAW_BRIDGE_ARGUMENT],
        equalsEnvironment,
      );
    } catch (error) {
      equalsError = error;
    }
    expect(equalsError).toBeInstanceOf(TypeError);
    expect(String(equalsError)).not.toContain(equalsSecret);
    expect(equalsEnvironment).toEqual({});
    expect(() =>
      resolveOpenClawBridgeInvocation([OPENCLAW_BRIDGE_ARGUMENT], {
        [OPENCLAW_REQUEST_ENVIRONMENT]: JSON.stringify({
          argv: ["version", "x".repeat(8 * 1024)],
          stdin_mode: "none",
        }),
      }),
    ).toThrow(/too large/iu);
    expect(() =>
      resolveOpenClawBridgeInvocation(
        [OPENCLAW_BRIDGE_ARGUMENT],
        {
          CREATORCUT_OPENCLAW_REQUEST_JSON: JSON.stringify({
            argv: ["version"],
            stdin_mode: "none",
          }),
          creatorcut_openclaw_request_json: JSON.stringify({
            argv: ["doctor"],
            stdin_mode: "none",
          }),
        },
        "win32",
      ),
    ).toThrow(/duplicate/iu);
  });

  it("reads one no-echo PTY JSON line and restores terminal mode", async () => {
    const modes: boolean[] = [];
    const lifecycle: string[] = [];
    const input = {
      isTTY: true,
      setRawMode: (mode: boolean) => modes.push(mode),
      resume: () => lifecycle.push("resume"),
      pause: () => lifecycle.push("pause"),
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('{"answer":"line\\nvalue"}');
        yield Buffer.from("\r");
      },
    };
    await expect(
      readOpenClawJsonLine(input, () => lifecycle.push("ready")),
    ).resolves.toBe('{"answer":"line\\nvalue"}');
    expect(modes).toEqual([true, false]);
    expect(lifecycle).toEqual(["resume", "ready", "pause"]);

    await expect(
      readOpenClawJsonLine(
        {
          ...input,
          isTTY: false,
        },
        () => undefined,
      ),
    ).rejects.toThrow(/PTY-backed/iu);

    await expect(
      readOpenClawJsonLine(
        {
          ...input,
          async *[Symbol.asyncIterator]() {
            yield Buffer.from("{}\rSECOND");
          },
        },
        () => undefined,
      ),
    ).rejects.toThrow(/exactly one line/iu);

    const maximum = Buffer.alloc(4 * 1024 * 1024, 0x20);
    await expect(
      readOpenClawJsonLine(
        {
          ...input,
          async *[Symbol.asyncIterator]() {
            yield maximum;
            yield Buffer.from("\n");
          },
        },
        () => undefined,
      ),
    ).resolves.toHaveLength(maximum.length);
    await expect(
      readOpenClawJsonLine(
        {
          ...input,
          async *[Symbol.asyncIterator]() {
            yield maximum;
            yield Buffer.from("x\n");
          },
        },
        () => undefined,
      ),
    ).rejects.toThrow(/too large/iu);
  });

  it("runs the fixed OpenClaw shell command with argv only in structured env", async () => {
    const cliRoot = join(import.meta.dirname, "..");
    const environment = {
      ...process.env,
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
      OPENCLAW_SHELL: "exec",
      [OPENCLAW_REQUEST_ENVIRONMENT]: JSON.stringify({
        argv: ["version"],
        stdin_mode: "none",
      }),
    };
    const invoked =
      process.platform === "win32"
        ? await execFileAsync(
            process.env.ComSpec ?? "cmd.exe",
            ["/d", "/s", "/c", "node dist\\src\\main.js __openclaw-bridge"],
            {
              cwd: cliRoot,
              encoding: "utf8",
              env: environment,
              windowsHide: true,
            },
          )
        : await execFileAsync(
            "/bin/sh",
            ["-c", "node dist/src/main.js __openclaw-bridge"],
            { cwd: cliRoot, encoding: "utf8", env: environment },
          );
    expect(invoked.stderr).toBe("");
    expect(JSON.parse(invoked.stdout)).toMatchObject({
      ok: true,
      command: "version",
      data: { version: "0.3.0-rc.2" },
    });
  });

  it("fails old OpenClaw Skills closed before project or secret access", async () => {
    const cliRoot = join(import.meta.dirname, "..");
    const privateProject = join(
      tmpdir(),
      "$(must-not-run)-private-project.creatorcut",
    );
    const apiKey = "am_must_never_echo";
    const environment = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SystemRoot: process.env.SystemRoot,
      OPENCLAW_SHELL: "exec",
    };
    let rejected: unknown;
    try {
      await execFileAsync(
        process.execPath,
        [
          "dist/src/main.js",
          "onboard",
          "--project",
          privateProject,
          `--key=${apiKey}`,
        ],
        {
          cwd: cliRoot,
          encoding: "utf8",
          env: environment,
          shell: false,
          windowsHide: true,
        },
      );
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeDefined();
    const failure = rejected as { stdout: string; stderr: string };
    expect(failure.stderr).toBe("");
    expect(failure.stdout).not.toContain(privateProject);
    expect(failure.stdout).not.toContain(apiKey);
    expect(JSON.parse(failure.stdout)).toEqual({
      schema_version: "creatorcut-cli/1.0",
      ok: false,
      command: "openclaw compatibility",
      requires_user_action: true,
      user_prompt:
        "Use the --force replacement command in skills/openclaw-creatorcut/README.md from the same verified release archive, then retry through the fixed creatorcut __openclaw-bridge command. Do not follow next_suggested as an executable command.",
      retryable: false,
      error: {
        code: "invalid_input",
        message:
          "This OpenClaw invocation did not use the matching CreatorCut fixed bridge contract",
      },
    });

    for (const argumentsWithoutBridge of [
      ["version"],
      ["--version"],
      ["doctor"],
    ]) {
      let directRejected: unknown;
      try {
        await execFileAsync(
          process.execPath,
          ["dist/src/main.js", ...argumentsWithoutBridge],
          {
            cwd: cliRoot,
            encoding: "utf8",
            env: environment,
            shell: false,
            windowsHide: true,
          },
        );
      } catch (error) {
        directRejected = error;
      }
      expect(directRejected).toBeDefined();
      const directFailure = directRejected as {
        stdout: string;
        stderr: string;
      };
      expect(directFailure.stderr).toBe("");
      expect(JSON.parse(directFailure.stdout)).toEqual(
        JSON.parse(failure.stdout),
      );
    }
  });
});
