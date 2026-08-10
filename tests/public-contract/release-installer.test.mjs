import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import {
  access,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { keysetSigningBytes } from "../../packages/protocol/dist/src/index.js";
import {
  releaseManifestSigningBytes,
  verifyReleaseKeyset,
} from "../../packages/release-manager/dist/src/index.js";
import { cleanWorkspaceDist } from "../../scripts/clean-workspace-dist.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function publicPem(key) {
  return key.export({ format: "pem", type: "spki" }).toString();
}

function releaseTrust(
  archiveSha256,
  commit,
  version = "0.1.0",
  minimumVersion = version,
) {
  const recovery = generateKeyPairSync("ed25519");
  const release = generateKeyPairSync("ed25519");
  const unsignedKeyset = {
    keyset_version: 1,
    purpose: "release",
    issued_at: "2026-07-01T00:00:00.000Z",
    expires_at: "2027-07-01T00:00:00.000Z",
    keys: [
      {
        key_id: "creatorcut-release-test",
        status: "current",
        public_key_pem: publicPem(release.publicKey),
        not_before: "2026-07-01T00:00:00.000Z",
        not_after: "2027-07-01T00:00:00.000Z",
      },
    ],
    signature: {
      algorithm: "Ed25519",
      key_id: "creatorcut-recovery-test",
      value: "",
    },
  };
  const keyset = {
    ...unsignedKeyset,
    signature: {
      ...unsignedKeyset.signature,
      value: sign(
        null,
        keysetSigningBytes(unsignedKeyset),
        recovery.privateKey,
      ).toString("base64"),
    },
  };
  const unsignedManifest = {
    product: "creatorcut",
    channel: "stable",
    latest_client_version: version,
    minimum_supported_version: minimumVersion,
    protocol_version: "1.0",
    git_tag: `v${version}`,
    git_commit: commit,
    artifact_sha256: archiveSha256,
    published_at: "2026-07-27T00:00:00.000Z",
    required: false,
    notes_url: `https://github.com/jiyangnan/AgentMesh-CreatorCut/releases/tag/v${version}`,
    key_id: "creatorcut-release-test",
    signature_algorithm: "Ed25519",
    signature: "",
  };
  const manifest = {
    ...unsignedManifest,
    signature: sign(
      null,
      releaseManifestSigningBytes(unsignedManifest),
      release.privateKey,
    ).toString("base64url"),
  };
  return {
    keyset,
    manifest,
    roots: {
      schema_version: 1,
      roots: [
        {
          key_id: "creatorcut-recovery-test",
          public_key_pem: publicPem(recovery.publicKey),
        },
      ],
    },
  };
}

async function fixtureRepository(root) {
  await mkdir(join(root, "release"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "creatorcut-installer-fixture",
        version: "0.1.0",
        private: true,
        type: "module",
        packageManager: "pnpm@10.30.3",
        engines: { node: ">=24 <25", pnpm: ">=10 <11" },
        scripts: { build: "node build.mjs" },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(root, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n",
  );
  await writeFile(
    join(root, "build.mjs"),
    `import { mkdir, writeFile } from "node:fs/promises";
await mkdir("apps/cli/dist/src", { recursive: true });
await writeFile("apps/cli/dist/src/main.js", \`#!/usr/bin/env node
const command = process.argv.slice(2).join(" ");
process.stdout.write(JSON.stringify({
  schema_version: "creatorcut-cli/1.0",
  ok: true,
  command,
  requires_user_action: false,
  retryable: false,
  data: command === "version"
    ? { version: "0.1.0" }
    : command === "doctor"
      ? { credential_storage: process.platform === "win32" ? "Windows DPAPI" : "test" }
      : {}
}, null, 2) + "\\\\n");
\`);
`,
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "CreatorCut Fixture"], {
    cwd: root,
  });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  execFileSync("git", ["tag", "v0.1.0"], { cwd: root });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const archive = execFileSync(
    "git",
    [
      "-c",
      "tar.umask=002",
      "-c",
      `core.attributesFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      "archive",
      "--format=tar",
      commit,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
      },
    },
  );
  return {
    commit,
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
  };
}

test("standalone verifier rejects a tampered release before checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "creatorcut-verifier-"));
  const trust = releaseTrust("b".repeat(64), "a".repeat(40));
  const manifestPath = join(root, "manifest.json");
  const keysetPath = join(root, "keyset.json");
  const rootsPath = join(root, "roots.json");
  await Promise.all([
    writeFile(
      manifestPath,
      JSON.stringify({ ...trust.manifest, product: "jobagent" }),
    ),
    writeFile(keysetPath, JSON.stringify(trust.keyset)),
    writeFile(rootsPath, JSON.stringify(trust.roots)),
  ]);

  await assert.rejects(
    execFileAsync(process.execPath, [
      join(repositoryRoot, "scripts", "verify-release.mjs"),
      "--manifest",
      manifestPath,
      "--keyset",
      keysetPath,
      "--recovery-roots",
      rootsPath,
      "--now",
      "2026-07-27T00:01:00.000Z",
    ]),
    /ReleaseManifest identity is invalid/u,
  );
});

test("standalone verifier accepts an immutable release candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "creatorcut-rc-verifier-"));
  const trust = releaseTrust(
    "b".repeat(64),
    "a".repeat(40),
    "0.1.0-rc.2",
    "0.1.0-rc.1",
  );
  const manifestPath = join(root, "manifest.json");
  const keysetPath = join(root, "keyset.json");
  const rootsPath = join(root, "roots.json");
  await Promise.all([
    writeFile(manifestPath, JSON.stringify(trust.manifest)),
    writeFile(keysetPath, JSON.stringify(trust.keyset)),
    writeFile(rootsPath, JSON.stringify(trust.roots)),
  ]);

  const result = await execFileAsync(process.execPath, [
    join(repositoryRoot, "scripts", "verify-release.mjs"),
    "--manifest",
    manifestPath,
    "--keyset",
    keysetPath,
    "--recovery-roots",
    rootsPath,
    "--now",
    "2026-07-27T00:01:00.000Z",
  ]);

  assert.equal(JSON.parse(result.stdout).version, "0.1.0-rc.2");
});

test("release trust generator separates private material and refuses overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "creatorcut-release-trust-"));
  const publicDirectory = join(root, "public");
  const privateDirectory = join(root, "private");
  const args = [
    join(repositoryRoot, "scripts", "generate-release-trust.mjs"),
    "--public-dir",
    publicDirectory,
    "--private-dir",
    privateDirectory,
    "--issued-at",
    "2026-07-27T00:00:00.000Z",
    "--expires-at",
    "2027-07-27T00:00:00.000Z",
    "--recovery-key-id",
    "creatorcut-recovery-test",
    "--release-key-id",
    "creatorcut-release-test",
    "--keyset-version",
    "1",
  ];
  const generated = await execFileAsync(process.execPath, args);
  const output = JSON.parse(generated.stdout);
  const roots = JSON.parse(
    await readFile(join(publicDirectory, "recovery-roots.json"), "utf8"),
  );
  const keyset = JSON.parse(
    await readFile(join(publicDirectory, "release-keyset.json"), "utf8"),
  );

  const trust = verifyReleaseKeyset({
    keyset,
    recoveryRoots: roots,
    minimumVersion: 1,
    now: new Date("2026-07-27T00:01:00.000Z"),
  });
  assert.equal(trust.keyset.keys[0].key_id, "creatorcut-release-test");
  assert.equal(output.release_key_id, "creatorcut-release-test");
  assert.deepEqual((await readdir(publicDirectory)).sort(), [
    "recovery-roots.json",
    "release-keyset.json",
  ]);
  assert.equal(resolve(output.private_directory), resolve(privateDirectory));
  assert.deepEqual((await readdir(privateDirectory)).sort(), [
    "creatorcut-recovery-test.private.pem",
    "creatorcut-release-test.seed.json",
  ]);
  if (process.platform !== "win32") {
    assert.equal((await stat(privateDirectory)).mode & 0o777, 0o700);
    assert.equal(
      (
        await stat(
          join(privateDirectory, "creatorcut-recovery-test.private.pem"),
        )
      ).mode & 0o777,
      0o600,
    );
    assert.equal(
      (await stat(join(privateDirectory, "creatorcut-release-test.seed.json")))
        .mode & 0o777,
      0o600,
    );
  }
  await assert.rejects(execFileAsync(process.execPath, args), /refusing/u);
});

test("installer and managed updater pin the frozen pnpm runtime", async () => {
  const installer = await readFile(
    join(repositoryRoot, "scripts", "install.sh"),
    "utf8",
  );
  const windowsInstaller = await readFile(
    join(repositoryRoot, "scripts", "install.ps1"),
    "utf8",
  );
  assert.doesNotMatch(windowsInstaller, /[^\x00-\x7f]/u);
  const updater = await readFile(
    join(repositoryRoot, "packages", "release-manager", "src", "update.ts"),
    "utf8",
  );
  const releaseWorkflow = await readFile(
    join(repositoryRoot, ".github", "workflows", "release.yml"),
    "utf8",
  );
  const cliPackage = JSON.parse(
    await readFile(join(repositoryRoot, "apps", "cli", "package.json"), "utf8"),
  );

  assert.match(installer, /cd "\$NEXT_DIR"/u);
  assert.match(installer, /NODE_VERSION="24\.18\.0"/u);
  assert.match(installer, /NODE_SHA256="[a-f0-9]{64}"/u);
  assert.match(installer, /MODEL_SHA256="[a-f0-9]{64}"/u);
  assert.match(installer, /export PATH=%q:"\$PATH"/u);
  assert.match(installer, /exec %q %q "\$@"/u);
  assert.doesNotMatch(installer, /exec node %q/u);
  assert.match(installer, /export CREATORCUT_DIRECTOR_ENDPOINT=%q/u);
  assert.match(installer, /export CREATORCUT_DIRECTOR_KEYSET=%q/u);
  assert.match(installer, /export CREATORCUT_PROTOCOL_BUNDLE_DIGEST=%q/u);
  assert.match(installer, /"\$SHIM" onboard/u);
  assert.match(installer, /"\$COREPACK_PATH" pnpm@10\.30\.3 install/u);
  assert.doesNotMatch(installer, /corepack pnpm --dir/u);
  assert.match(installer, /"\$COREPACK_PATH" pnpm@10\.30\.3 build/u);
  assert.match(windowsInstaller, /\$NodeVersion = "24\.18\.0"/u);
  assert.match(windowsInstaller, /\$NodeSha256 = "[a-f0-9]{64}"/u);
  assert.match(windowsInstaller, /\$GitVersion = "2\.55\.0\.3"/u);
  assert.match(windowsInstaller, /\$GitSha256 = "[a-f0-9]{64}"/u);
  assert.match(windowsInstaller, /\$FfmpegVersion = "8\.1\.2"/u);
  assert.match(windowsInstaller, /\$FfmpegSha256 = "[a-f0-9]{64}"/u);
  assert.match(windowsInstaller, /& \$NodePath --version/u);
  assert.doesNotMatch(windowsInstaller, /& \$NodePath -p/u);
  for (const variableName of [
    "GIT_CONFIG_NOSYSTEM",
    "GIT_ATTR_NOSYSTEM",
    "GIT_NO_REPLACE_OBJECTS",
  ]) {
    assert.ok(windowsInstaller.includes(`"${variableName}"`));
  }
  assert.match(
    windowsInstaller,
    /GetEnvironmentVariable\(\$variableName, "Process"\)[\s\S]+SetEnvironmentVariable\(\$variableName, "1", "Process"\)[\s\S]+finally[\s\S]+\$gitArchiveEnvironment\[\$variableName\][\s\S]+"Process"/u,
  );
  assert.match(
    windowsInstaller,
    /install `\s+--frozen-lockfile --offline --force/u,
  );
  assert.match(
    windowsInstaller,
    /Rebinding Windows workspace links at the final install path/u,
  );
  assert.match(
    windowsInstaller,
    /releases\/download\/v2\.55\.0\.windows\.3\/MinGit-2\.55\.0\.3-64-bit\.zip/u,
  );
  assert.match(
    windowsInstaller,
    /releases\/download\/8\.1\.2\/ffmpeg-8\.1\.2-essentials_build\.zip/u,
  );
  assert.doesNotMatch(windowsInstaller, /winget/u);
  assert.match(windowsInstaller, /\$WhisperSha256 = "[a-f0-9]{64}"/u);
  assert.match(windowsInstaller, /"Windows DPAPI"/u);
  assert.match(
    windowsInstaller,
    /CREATORCUT_DIRECTOR_ENDPOINT=\$DirectorApiBase/u,
  );
  assert.match(
    windowsInstaller,
    /CREATORCUT_PROTOCOL_BUNDLE_DIGEST=\$ProtocolBundleDigest/u,
  );
  assert.match(windowsInstaller, /& \$shim onboard/u);
  assert.doesNotMatch(
    windowsInstaller,
    /CREATORCUT_(?:API_KEY|CORE_SERVICE_TOKEN)\s*=/u,
  );
  assert.match(updater, /"pnpm@10\.30\.3"/u);
  assert.match(updater, /"build"/u);
  assert.match(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
    /node scripts\/clean-dist\.mjs && pnpm -r --if-present build/u,
  );
  assert.match(releaseWorkflow, /notes="docs\/releases\/v\$\{version\}\.md"/u);
  assert.match(releaseWorkflow, /test -f "\$notes"/u);
  assert.ok(
    releaseWorkflow.indexOf('test -f "$notes"') <
      releaseWorkflow.indexOf("pnpm install --frozen-lockfile"),
  );
  assert.match(releaseWorkflow, /--notes-file "\$RELEASE_NOTES"/u);
  assert.doesNotMatch(releaseWorkflow, /--generate-notes/u);
  assert.match(releaseWorkflow, /"\$GITHUB_REF_NAME" == \*-\*/u);
  assert.match(
    releaseWorkflow,
    /release_flags\+=\(--prerelease --latest=false\)/u,
  );
  assert.match(releaseWorkflow, /"\$\{release_flags\[@\]\}"/u);
  await access(
    join(repositoryRoot, "docs", "releases", `v${cliPackage.version}.md`),
  );
});

test("mutable workspace builds remove only their own generated dist", async () => {
  const expectedBuild =
    "node ../../scripts/clean-workspace-dist.mjs && tsc --project tsconfig.build.json";
  let mutableWorkspaceCount = 0;
  for (const workspaceGroup of ["apps", "packages"]) {
    const groupRoot = join(repositoryRoot, workspaceGroup);
    const entries = await readdir(groupRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const manifestPath = join(groupRoot, entry.name, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (workspaceGroup === "packages" && entry.name === "protocol") {
        assert.equal(
          manifest.scripts?.build,
          "tsc --project tsconfig.build.json",
          "Protocol v1 package.json is part of the frozen signed bundle",
        );
        continue;
      }
      assert.equal(manifest.scripts?.build, expectedBuild, manifestPath);
      mutableWorkspaceCount += 1;
    }
  }
  assert.equal(mutableWorkspaceCount, 11);

  const fixtureRoot = await mkdtemp(
    join(tmpdir(), "creatorcut-workspace-cleaner-"),
  );
  const outsideRoot = await mkdtemp(
    join(tmpdir(), "creatorcut-clean-outside-"),
  );
  const outsideSentinel = join(outsideRoot, "sentinel.txt");
  await writeFile(outsideSentinel, "outside\n");

  const cleanWorkspace = join(fixtureRoot, "apps", "clean-fixture");
  await mkdir(join(cleanWorkspace, "dist", "nested"), { recursive: true });
  await Promise.all([
    writeFile(join(cleanWorkspace, "package.json"), "{}\n"),
    writeFile(join(cleanWorkspace, "dist", "nested", "stale.js"), "stale\n"),
  ]);
  await cleanWorkspaceDist({
    repositoryRoot: fixtureRoot,
    workspaceDirectory: cleanWorkspace,
  });
  await assert.rejects(access(join(cleanWorkspace, "dist")), {
    code: "ENOENT",
  });
  assert.equal(await readFile(outsideSentinel, "utf8"), "outside\n");

  await cleanWorkspaceDist({
    repositoryRoot: fixtureRoot,
    workspaceDirectory: cleanWorkspace,
  });

  const fileWorkspace = join(fixtureRoot, "packages", "file-fixture");
  await mkdir(fileWorkspace, { recursive: true });
  await Promise.all([
    writeFile(join(fileWorkspace, "package.json"), "{}\n"),
    writeFile(join(fileWorkspace, "dist"), "not a directory\n"),
  ]);
  await assert.rejects(
    cleanWorkspaceDist({
      repositoryRoot: fixtureRoot,
      workspaceDirectory: fileWorkspace,
    }),
    /Refusing to clean a non-directory dist path/u,
  );

  const nestedWorkspace = join(
    fixtureRoot,
    "packages",
    "nested",
    "not-a-workspace",
  );
  await mkdir(nestedWorkspace, { recursive: true });
  await writeFile(join(nestedWorkspace, "package.json"), "{}\n");
  await assert.rejects(
    cleanWorkspaceDist({
      repositoryRoot: fixtureRoot,
      workspaceDirectory: nestedWorkspace,
    }),
    /Refusing to clean a non-workspace directory/u,
  );

  if (process.platform !== "win32") {
    const linkedWorkspace = join(fixtureRoot, "packages", "link-fixture");
    await mkdir(linkedWorkspace, { recursive: true });
    await writeFile(join(linkedWorkspace, "package.json"), "{}\n");
    await symlink(outsideRoot, join(linkedWorkspace, "dist"), "dir");
    await assert.rejects(
      cleanWorkspaceDist({
        repositoryRoot: fixtureRoot,
        workspaceDirectory: linkedWorkspace,
      }),
      /Refusing to clean a non-directory dist path/u,
    );
  }

  assert.equal(await readFile(outsideSentinel, "utf8"), "outside\n");
});

test(
  "v0.2.1 rollback cannot reach a newer runtime residue through old public entrypoints",
  { timeout: 120_000 },
  async () => {
    const fixtureRoot = await mkdtemp(
      join(tmpdir(), "creatorcut-v021-rollback-"),
    );
    const oldRoot = join(fixtureRoot, "source");
    const nodeDirectory = dirname(process.execPath);
    const testEnvironment = {
      ...process.env,
      CI: "1",
      PATH: `${nodeDirectory}${delimiter}${process.env.PATH ?? ""}`,
    };
    await execFileAsync(
      "git",
      ["clone", "--quiet", "--no-checkout", repositoryRoot, oldRoot],
      { env: testEnvironment },
    );
    await execFileAsync("git", ["checkout", "--quiet", "--detach", "v0.2.1"], {
      cwd: oldRoot,
      env: testEnvironment,
    });

    const corepack =
      process.platform === "win32"
        ? process.execPath
        : join(nodeDirectory, "corepack");
    const corepackArguments =
      process.platform === "win32"
        ? [
            join(
              nodeDirectory,
              "node_modules",
              "corepack",
              "dist",
              "corepack.js",
            ),
          ]
        : [];
    const warmStore = (
      await execFileAsync(
        corepack,
        [...corepackArguments, "pnpm@10.30.3", "store", "path"],
        { cwd: repositoryRoot, env: testEnvironment },
      )
    ).stdout.trim();
    assert.ok(warmStore);
    await execFileAsync(
      corepack,
      [
        ...corepackArguments,
        "pnpm@10.30.3",
        "install",
        "--offline",
        "--frozen-lockfile",
        "--store-dir",
        warmStore,
      ],
      { cwd: oldRoot, env: testEnvironment },
    );
    await execFileAsync(
      corepack,
      [
        ...corepackArguments,
        "pnpm@10.30.3",
        "--filter",
        "!agentmesh-creatorcut",
        "-r",
        "--if-present",
        "build",
      ],
      { cwd: oldRoot, env: testEnvironment },
    );

    const residueSentinel = join(fixtureRoot, "residue-loaded.txt");
    const residuePath = join(
      oldRoot,
      "packages",
      "runtime",
      "dist",
      "src",
      "storage-authority.js",
    );
    await writeFile(
      residuePath,
      `import { writeFileSync } from "node:fs";
writeFileSync(process.env.CREATORCUT_RESIDUE_SENTINEL, "loaded\\n");
export const migrateLegacyInternalProject = () => undefined;
export const rollbackStorageAuthorityMigration = () => undefined;
`,
    );
    const residueEnvironment = {
      ...testEnvironment,
      CREATORCUT_RESIDUE_SENTINEL: residueSentinel,
    };
    const packageProbe = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const runtime = await import("@agentmesh/creatorcut-runtime");
for (const name of ["migrateLegacyInternalProject", "rollbackStorageAuthorityMigration"]) {
  if (Object.hasOwn(runtime, name)) throw new Error(\`old runtime exports \${name}\`);
}
let code = "";
try {
  await import("@agentmesh/creatorcut-runtime/dist/src/storage-authority.js");
} catch (error) {
  code = error?.code ?? "";
}
if (code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw new Error(\`unexpected subpath result: \${code}\`);
process.stdout.write(JSON.stringify({ public_root: true, private_subpath: code }));`,
      ],
      {
        cwd: join(oldRoot, "apps", "cli"),
        env: residueEnvironment,
      },
    );
    assert.deepEqual(JSON.parse(packageProbe.stdout), {
      public_root: true,
      private_subpath: "ERR_PACKAGE_PATH_NOT_EXPORTED",
    });
    await assert.rejects(access(residueSentinel), { code: "ENOENT" });

    const oldCliPackage = JSON.parse(
      await readFile(join(oldRoot, "apps", "cli", "package.json"), "utf8"),
    );
    const oldCli = join(oldRoot, "apps", "cli", "dist", "src", "main.js");
    const version = await execFileAsync(process.execPath, [oldCli, "version"], {
      cwd: oldRoot,
      env: residueEnvironment,
    });
    assert.equal(
      JSON.parse(version.stdout).data.version,
      oldCliPackage.version,
    );

    const projectSentinel = join(fixtureRoot, "project-sentinel");
    await mkdir(projectSentinel);
    for (const command of ["migrate-internal", "rollback-internal"]) {
      const result = await execFileAsync(
        process.execPath,
        [oldCli, "project", command, "--backup", join(fixtureRoot, "unused")],
        { cwd: projectSentinel, env: residueEnvironment },
      ).then(
        ({ stdout, stderr }) => ({ exitCode: 0, stdout, stderr }),
        (error) => ({
          exitCode: error.code,
          stdout: error.stdout,
          stderr: error.stderr,
        }),
      );
      assert.equal(result.exitCode, 1);
      assert.equal(result.stderr, "");
      assert.match(
        JSON.parse(result.stdout).error.message,
        new RegExp(`Unknown CreatorCut command: project ${command}`, "u"),
      );
    }
    assert.deepEqual(await readdir(projectSentinel), []);
    await assert.rejects(access(residueSentinel), { code: "ENOENT" });
  },
);

test("clean Unix fixture installs only the signed tag, commit and archive", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "creatorcut-clean-install-"));
  const source = join(root, "public-source");
  const home = join(root, "home");
  const install = join(home, ".local", "share", "creatorcut");
  const bin = join(home, ".local", "bin");
  const fakeBin = join(root, "fake-bin");
  await Promise.all([
    mkdir(source, { recursive: true }),
    mkdir(fakeBin, { recursive: true }),
    mkdir(join(home, "model"), { recursive: true }),
  ]);
  const identity = await fixtureRepository(source);
  const trust = releaseTrust(identity.archiveSha256, identity.commit);
  const directorKeysetSha256 = createHash("sha256")
    .update(JSON.stringify(trust.keyset))
    .digest("hex");
  const directorRecoveryRootsSha256 = createHash("sha256")
    .update(JSON.stringify(trust.roots))
    .digest("hex");
  const keysetPath = join(root, "keyset.json");
  const rootsPath = join(root, "roots.json");
  const modelPath = join(home, "model", "ggml-base.bin");
  const whisperPath = join(fakeBin, "whisper-cli");
  await Promise.all([
    writeFile(keysetPath, JSON.stringify(trust.keyset)),
    writeFile(rootsPath, JSON.stringify(trust.roots)),
    writeFile(modelPath, "fixture model"),
    writeFile(whisperPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 }),
  ]);
  for (const command of ["ffmpeg", "ffprobe"]) {
    await writeFile(join(fakeBin, command), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
  }

  const server = createServer((request, response) => {
    if (request.url === "/v1/products/creatorcut/client-release") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(trust.manifest));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise((resolvePromise) =>
    server.listen(0, "127.0.0.1", resolvePromise),
  );
  const address = server.address();
  assert(address && typeof address === "object");

  const nodeBin = dirname(process.execPath);
  try {
    await execFileAsync(
      "bash",
      [join(repositoryRoot, "scripts", "install.sh")],
      {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${fakeBin}:${nodeBin}:/usr/local/bin:/usr/bin:/bin`,
          COREPACK_HOME: join(process.env.HOME, ".cache", "node", "corepack"),
          CREATORCUT_REPO_URL: source,
          CREATORCUT_INSTALL_DIR: install,
          CREATORCUT_BIN_DIR: bin,
          CREATORCUT_CORE_API_BASE: `http://127.0.0.1:${address.port}`,
          CREATORCUT_RELEASE_VERIFIER_URL: `file://${join(
            repositoryRoot,
            "scripts",
            "verify-release.mjs",
          )}`,
          CREATORCUT_RELEASE_RECOVERY_ROOTS_URL: `file://${rootsPath}`,
          CREATORCUT_RELEASE_KEYSET_URL: `file://${keysetPath}`,
          CREATORCUT_DIRECTOR_KEYSET_URL: `file://${keysetPath}`,
          CREATORCUT_DIRECTOR_RECOVERY_ROOTS_URL: `file://${rootsPath}`,
          CREATORCUT_DIRECTOR_KEYSET_SHA256: directorKeysetSha256,
          CREATORCUT_DIRECTOR_RECOVERY_ROOTS_SHA256:
            directorRecoveryRootsSha256,
          CREATORCUT_WHISPER: whisperPath,
          CREATORCUT_WHISPER_MODEL: modelPath,
          CREATORCUT_SKIP_DEPENDENCY_INSTALL: "1",
          CREATORCUT_KEYCHAIN_PATH: join(root, "fixture.keychain-db"),
        },
        timeout: 30_000,
      },
    );
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }

  const metadata = JSON.parse(
    await readFile(join(install, ".creatorcut-install.json"), "utf8"),
  );
  assert.equal(metadata.git_commit, identity.commit);
  assert.equal(metadata.artifact_sha256, identity.archiveSha256);
  assert.equal(metadata.version, "0.1.0");
  await writeFile(join(fakeBin, "node"), "#!/bin/sh\nexit 99\n", {
    mode: 0o755,
  });
  const version = JSON.parse(
    (
      await execFileAsync(join(bin, "creatorcut"), ["version"], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/local/bin:/usr/bin:/bin`,
        },
      })
    ).stdout,
  );
  assert.equal(version.data.version, "0.1.0");
});

test("clean Windows fixture installs only the signed tag, commit and archive", async () => {
  if (process.platform !== "win32") return;
  const root = await mkdtemp(join(tmpdir(), "creatorcut-clean-install-"));
  const source = join(root, "public-source");
  const home = join(root, "home");
  const install = join(home, "app");
  const data = join(home, "data");
  const bin = join(home, "bin");
  const fakeBin = join(root, "fake-bin");
  const modelPath = join(home, "model", "ggml-base.bin");
  const whisperPath = join(fakeBin, "whisper-cli.exe");
  await Promise.all([
    mkdir(source, { recursive: true }),
    mkdir(fakeBin, { recursive: true }),
    mkdir(dirname(modelPath), { recursive: true }),
  ]);
  const identity = await fixtureRepository(source);
  const trust = releaseTrust(identity.archiveSha256, identity.commit);
  const directorKeysetSha256 = createHash("sha256")
    .update(JSON.stringify(trust.keyset))
    .digest("hex");
  const directorRecoveryRootsSha256 = createHash("sha256")
    .update(JSON.stringify(trust.roots))
    .digest("hex");
  const keysetPath = join(root, "keyset.json");
  const rootsPath = join(root, "roots.json");
  await Promise.all([
    writeFile(keysetPath, JSON.stringify(trust.keyset)),
    writeFile(rootsPath, JSON.stringify(trust.roots)),
    writeFile(modelPath, "fixture model"),
    copyFile(process.execPath, whisperPath),
    copyFile(process.execPath, join(fakeBin, "ffmpeg.exe")),
    copyFile(process.execPath, join(fakeBin, "ffprobe.exe")),
  ]);

  const server = createServer((request, response) => {
    if (request.url === "/v1/products/creatorcut/client-release") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(trust.manifest));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise((resolvePromise) =>
    server.listen(0, "127.0.0.1", resolvePromise),
  );
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(repositoryRoot, "scripts", "install.ps1"),
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          LOCALAPPDATA: home,
          PATH: `${fakeBin};${dirname(process.execPath)};${process.env.PATH}`,
          CREATORCUT_REPO_URL: source,
          CREATORCUT_INSTALL_DIR: install,
          CREATORCUT_DATA_DIR: data,
          CREATORCUT_BIN_DIR: bin,
          CREATORCUT_CORE_API_BASE: `http://127.0.0.1:${address.port}`,
          CREATORCUT_RELEASE_VERIFIER_URL: pathToFileURL(
            join(repositoryRoot, "scripts", "verify-release.mjs"),
          ).href,
          CREATORCUT_RELEASE_RECOVERY_ROOTS_URL: pathToFileURL(rootsPath).href,
          CREATORCUT_RELEASE_KEYSET_URL: pathToFileURL(keysetPath).href,
          CREATORCUT_DIRECTOR_KEYSET_URL: pathToFileURL(keysetPath).href,
          CREATORCUT_DIRECTOR_RECOVERY_ROOTS_URL: pathToFileURL(rootsPath).href,
          CREATORCUT_DIRECTOR_KEYSET_SHA256: directorKeysetSha256,
          CREATORCUT_DIRECTOR_RECOVERY_ROOTS_SHA256:
            directorRecoveryRootsSha256,
          CREATORCUT_WHISPER: whisperPath,
          CREATORCUT_WHISPER_MODEL: modelPath,
          CREATORCUT_SKIP_DEPENDENCY_INSTALL: "1",
        },
        timeout: 30_000,
      },
    );
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }

  const metadata = JSON.parse(
    await readFile(join(install, ".creatorcut-install.json"), "utf8"),
  );
  assert.equal(metadata.git_commit, identity.commit);
  assert.equal(metadata.artifact_sha256, identity.archiveSha256);
  assert.equal(metadata.version, "0.1.0");
  const version = await execFileAsync(
    "cmd.exe",
    ["/d", "/s", "/c", "call", ".\\creatorcut.cmd", "version"],
    { cwd: bin, env: process.env },
  );
  assert.equal(JSON.parse(version.stdout).data.version, "0.1.0");
});
