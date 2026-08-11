import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const protocolRoot = resolve(root, "packages", "protocol");
const execFileAsync = promisify(execFile);

test("compiled protocol is a standalone Node 24 ESM package", async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(protocolRoot, "package.json"), "utf8"),
  );
  assert.equal(packageJson.exports["."].import, "./dist/src/index.js");
  assert.equal(packageJson.exports["."].types, "./dist/src/index.d.ts");

  const entry = resolve(protocolRoot, "dist", "src", "index.js");
  const declaration = resolve(protocolRoot, "dist", "src", "index.d.ts");
  const contextSchema = resolve(
    protocolRoot,
    "dist",
    "schemas",
    "director-context.schema.json",
  );
  await Promise.all([
    access(entry),
    access(declaration),
    access(contextSchema),
  ]);

  const protocol = await import(pathToFileURL(entry).href);
  assert.equal(protocol.DIRECTOR_PROTOCOL_VERSION, "1.0");
  assert.equal(
    protocol.CREATORCUT_LIMITS_V1.limits_version,
    "creatorcut-limits/1.0",
  );
});

test("compiled CLI exposes a cross-platform shell-free next process", async () => {
  const cliRoot = resolve(root, "apps", "cli", "dist", "src");
  const mainModule = resolve(cliRoot, "main.js");
  const pathValue = process.env.PATH ?? "";
  const { withNextProcess } = await import(
    pathToFileURL(resolve(cliRoot, "next-process.js")).href
  );
  const envelope = withNextProcess(
    {
      schema_version: "creatorcut-cli/1.0",
      ok: true,
      command: "probe",
      requires_user_action: false,
      retryable: false,
      next_suggested: "version",
      next_argv: ["version"],
      data: {},
    },
    {
      executable: process.execPath,
      mainModule,
      cwd: root,
      environment: { PATH: pathValue },
    },
  );
  assert.deepEqual(envelope.next_process, {
    executable: process.execPath,
    argv: [mainModule, "version"],
    cwd: root,
    env_overrides: { PATH: pathValue },
    shell: false,
  });
  assert.deepEqual(envelope.next_openclaw, {
    exec: {
      command: "creatorcut __openclaw-bridge",
      workdir: root,
      env: {
        CREATORCUT_OPENCLAW_REQUEST_JSON:
          '{"argv":["version"],"stdin_mode":"none"}',
      },
      pty: false,
      background: false,
    },
    input: { mode: "none" },
  });
  const invoked = await execFileAsync(
    envelope.next_process.executable,
    envelope.next_process.argv,
    {
      cwd: envelope.next_process.cwd,
      encoding: "utf8",
      env: { ...process.env, ...envelope.next_process.env_overrides },
      shell: false,
      windowsHide: true,
    },
  );
  assert.equal(invoked.stderr, "");
  const response = JSON.parse(invoked.stdout);
  const packageJson = JSON.parse(
    await readFile(resolve(root, "apps", "cli", "package.json"), "utf8"),
  );
  assert.equal(response.ok, true);
  assert.equal(response.command, "version");
  assert.equal(response.data.version, packageJson.version);

  const cliPackageRoot = resolve(root, "apps", "cli");
  const bridgeEnvironment = {
    ...process.env,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    CREATORCUT_OPENCLAW_REQUEST_JSON:
      '{"argv":["version"],"stdin_mode":"none"}',
  };
  const bridged =
    process.platform === "win32"
      ? await execFileAsync(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", "node dist\\src\\main.js __openclaw-bridge"],
          {
            cwd: cliPackageRoot,
            encoding: "utf8",
            env: bridgeEnvironment,
            windowsHide: true,
          },
        )
      : await execFileAsync(
          "/bin/sh",
          ["-c", "node dist/src/main.js __openclaw-bridge"],
          { cwd: cliPackageRoot, encoding: "utf8", env: bridgeEnvironment },
        );
  assert.equal(bridged.stderr, "");
  assert.deepEqual(JSON.parse(bridged.stdout).data, {
    version: packageJson.version,
  });
});
