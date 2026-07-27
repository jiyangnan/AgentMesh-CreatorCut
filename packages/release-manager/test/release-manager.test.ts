import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalizeJcs,
  keysetSigningBytes,
  type SignedArtifactKeyset,
} from "@agentmesh/creatorcut-protocol";
import { describe, expect, it } from "vitest";

import {
  applyManagedUpdate,
  fetchVerifiedReleaseManifest,
  findActiveProjectTasks,
  releaseCheck,
  releaseManifestSigningBytes,
  verifyReleaseKeyset,
  verifyReleaseManifest,
  type ManagedInstallMetadata,
  type ReleaseManifest,
  type RunCommand,
} from "../src/index.js";

function publicPem(key: KeyObject): string {
  return key.export({ format: "pem", type: "spki" }).toString();
}

function signedFixture(archive = Buffer.from("creatorcut-release-archive")) {
  const recovery = generateKeyPairSync("ed25519");
  const release = generateKeyPairSync("ed25519");
  const unsignedKeyset: SignedArtifactKeyset = {
    keyset_version: 3,
    purpose: "release",
    issued_at: "2026-07-01T00:00:00.000Z",
    expires_at: "2027-07-01T00:00:00.000Z",
    keys: [
      {
        key_id: "creatorcut-release-2026-01",
        status: "current",
        public_key_pem: publicPem(release.publicKey),
        not_before: "2026-07-01T00:00:00.000Z",
        not_after: "2027-07-01T00:00:00.000Z",
      },
    ],
    signature: {
      algorithm: "Ed25519",
      key_id: "creatorcut-recovery-2026-01",
      value: "",
    },
  };
  const keyset: SignedArtifactKeyset = {
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
  const trust = verifyReleaseKeyset({
    keyset,
    recoveryRoots: {
      schema_version: 1,
      roots: [
        {
          key_id: "creatorcut-recovery-2026-01",
          public_key_pem: publicPem(recovery.publicKey),
        },
      ],
    },
    minimumVersion: 3,
    now: new Date("2026-07-27T00:00:00.000Z"),
  });
  const unsignedManifest: ReleaseManifest = {
    product: "creatorcut",
    channel: "stable",
    latest_client_version: "0.2.0",
    minimum_supported_version: "0.1.0",
    protocol_version: "1.0",
    git_tag: "v0.2.0",
    git_commit: "a".repeat(40),
    artifact_sha256: createHash("sha256").update(archive).digest("hex"),
    published_at: "2026-07-27T00:00:00.000Z",
    required: false,
    notes_url:
      "https://github.com/jiyangnan/AgentMesh-CreatorCut/releases/tag/v0.2.0",
    key_id: "creatorcut-release-2026-01",
    signature_algorithm: "Ed25519",
    signature: "",
  };
  const manifest: ReleaseManifest = {
    ...unsignedManifest,
    signature: sign(
      null,
      releaseManifestSigningBytes(unsignedManifest),
      release.privateKey,
    ).toString("base64url"),
  };
  return { archive, keyset, manifest, release, trust };
}

describe("CreatorCut release verification", () => {
  it("verifies recovery-root rotation and the exact signed manifest", () => {
    const fixture = signedFixture();
    const verified = verifyReleaseManifest(fixture.manifest, fixture.trust, {
      now: new Date("2026-07-27T00:01:00.000Z"),
    });

    expect(verified.latest_client_version).toBe("0.2.0");
    expect(releaseCheck("0.1.0", verified).status).toBe("update_available");
  });

  it.each([
    ["product", "jobagent"],
    ["channel", "preview"],
    ["git_tag", "v9.9.9"],
    ["git_commit", "b".repeat(40)],
    ["artifact_sha256", "c".repeat(64)],
  ])("fails closed when %s is tampered", (field, value) => {
    const fixture = signedFixture();
    const tampered = { ...fixture.manifest, [field]: value };

    expect(() =>
      verifyReleaseManifest(tampered, fixture.trust, {
        now: new Date("2026-07-27T00:01:00.000Z"),
      }),
    ).toThrow();
  });

  it("does not fall back to an unsigned repository latest when Core is unavailable", async () => {
    const fixture = signedFixture();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("unavailable", { status: 503 });
    };

    await expect(
      fetchVerifiedReleaseManifest({
        endpoint:
          "https://api.agentmesh360.com/v1/products/creatorcut/client-release",
        trust: fixture.trust,
        fetchImpl,
      }),
    ).rejects.toThrow("HTTP 503");
    expect(calls).toBe(1);
  });

  it("accepts and orders immutable SemVer release candidates", () => {
    const fixture = signedFixture();
    const unsignedManifest: ReleaseManifest = {
      ...fixture.manifest,
      latest_client_version: "0.1.0-rc.2",
      minimum_supported_version: "0.1.0-rc.1",
      git_tag: "v0.1.0-rc.2",
      signature: "",
    };
    const manifest: ReleaseManifest = {
      ...unsignedManifest,
      signature: sign(
        null,
        releaseManifestSigningBytes(unsignedManifest),
        fixture.release.privateKey,
      ).toString("base64url"),
    };
    const verified = verifyReleaseManifest(manifest, fixture.trust);

    expect(releaseCheck("0.1.0-rc.1", verified).status).toBe(
      "update_available",
    );
    expect(releaseCheck("0.1.0", verified).status).toBe("current");
  });
});

describe("CreatorCut managed updates", () => {
  it("detects active local media work before changing the install", async () => {
    const project = await mkdtemp(join(tmpdir(), "creatorcut-project-"));
    const tasks = join(project, ".creatorcut", "tasks");
    await mkdir(tasks, { recursive: true });
    await writeFile(
      join(tasks, "export.json"),
      JSON.stringify({ state: "finalizing" }),
      "utf8",
    );

    await expect(findActiveProjectTasks(project)).resolves.toMatchObject([
      { kind: "export", state: "finalizing" },
    ]);
  });

  it("rolls back the managed checkout when the new build fails", async () => {
    const fixture = signedFixture();
    const manifest = verifyReleaseManifest(fixture.manifest, fixture.trust, {
      now: new Date("2026-07-27T00:01:00.000Z"),
    });
    const root = await mkdtemp(join(tmpdir(), "creatorcut-install-"));
    const metadataPath = join(root, ".creatorcut-install.json");
    const metadata: ManagedInstallMetadata = {
      schema_version: "creatorcut-managed-install/1.0",
      managed: true,
      install_type: "official-installer",
      repository: "https://github.com/jiyangnan/AgentMesh-CreatorCut.git",
      install_dir: root,
      version: "0.1.0",
      git_tag: "v0.1.0",
      git_commit: "d".repeat(40),
      artifact_sha256: "e".repeat(64),
      release_keyset_version: 3,
      installed_at: "2026-07-01T00:00:00.000Z",
    };
    await writeFile(metadataPath, JSON.stringify(metadata), "utf8");

    await expect(
      applyManagedUpdate({
        manifest,
        releaseKeysetVersion: 2,
        metadataPath,
        platform: "darwin",
      }),
    ).rejects.toThrow("keyset rollback");

    const commands: string[] = [];
    let buildCount = 0;
    const run: RunCommand = async ({ command, args }) => {
      const key = `${command} ${args.join(" ")}`;
      commands.push(key);
      if (key === "git remote get-url origin") {
        return {
          exitCode: 0,
          stdout: Buffer.from(`${metadata.repository}\n`),
          stderr: Buffer.alloc(0),
        };
      }
      if (key === "git status --porcelain --untracked-files=no") {
        return {
          exitCode: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        };
      }
      if (key === "git rev-parse HEAD") {
        return {
          exitCode: 0,
          stdout: Buffer.from(`${metadata.git_commit}\n`),
          stderr: Buffer.alloc(0),
        };
      }
      if (key === `git rev-parse ${manifest.git_tag}^{commit}`) {
        return {
          exitCode: 0,
          stdout: Buffer.from(`${manifest.git_commit}\n`),
          stderr: Buffer.alloc(0),
        };
      }
      if (key.includes("archive --format=tar")) {
        return {
          exitCode: 0,
          stdout: fixture.archive,
          stderr: Buffer.alloc(0),
        };
      }
      if (
        key ===
        "corepack pnpm@10.30.3 --filter !agentmesh-creatorcut -r --if-present build"
      ) {
        buildCount += 1;
        if (buildCount === 1) {
          return {
            exitCode: 1,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from("synthetic build failure"),
          };
        }
      }
      return {
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      };
    };

    await expect(
      applyManagedUpdate({
        manifest,
        releaseKeysetVersion: fixture.trust.keyset.keyset_version,
        metadataPath,
        run,
        platform: "darwin",
      }),
    ).rejects.toThrow("was rolled back");
    expect(commands).toContain(`git checkout --detach ${metadata.git_commit}`);
    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toEqual(metadata);
  });
});

it("uses canonical JSON for a stable release signing payload", () => {
  const fixture = signedFixture();
  const { signature: _signature, ...unsigned } = fixture.manifest;
  expect(
    Buffer.from(releaseManifestSigningBytes(fixture.manifest)).toString(),
  ).toBe(canonicalizeJcs(unsigned));
});
