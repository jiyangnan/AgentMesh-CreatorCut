import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { keysetSigningBytes } from "../../packages/protocol/dist/src/index.js";
import { releaseManifestSigningBytes } from "../../packages/release-manager/dist/src/index.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(
  dirname(new URL(import.meta.url).pathname),
  "../..",
);

function publicPem(key) {
  return key.export({ format: "pem", type: "spki" }).toString();
}

function releaseTrust(archiveSha256, commit) {
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
    latest_client_version: "0.1.0",
    minimum_supported_version: "0.1.0",
    protocol_version: "1.0",
    git_tag: "v0.1.0",
    git_commit: commit,
    artifact_sha256: archiveSha256,
    published_at: "2026-07-27T00:00:00.000Z",
    required: false,
    notes_url:
      "https://github.com/jiyangnan/AgentMesh-CreatorCut/releases/tag/v0.1.0",
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
  data: command === "version" ? { version: "0.1.0" } : {}
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
      "core.attributesFile=/dev/null",
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

test("clean macOS fixture installs only the signed tag, commit and archive", async () => {
  if (process.platform !== "darwin") return;
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
          CREATORCUT_WHISPER: whisperPath,
          CREATORCUT_WHISPER_MODEL: modelPath,
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
  const version = JSON.parse(
    (
      await execFileAsync(join(bin, "creatorcut"), ["version"], {
        env: {
          ...process.env,
          PATH: `${nodeBin}:/usr/local/bin:/usr/bin:/bin`,
        },
      })
    ).stdout,
  );
  assert.equal(version.data.version, "0.1.0");
});
