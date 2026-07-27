#!/usr/bin/env node

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { keysetSigningBytes } from "../packages/protocol/dist/src/index.js";

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function argumentsMap(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      fail(`invalid argument near ${name ?? "<end>"}`);
    }
    values.set(name.slice(2), value);
    index += 1;
  }
  return values;
}

function required(values, name) {
  const value = values.get(name);
  if (!value) fail(`--${name} is required`);
  return value;
}

function publicPem(key) {
  return key.export({ format: "pem", type: "spki" }).toString();
}

function isoDate(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail(`${label} must be an ISO-8601 date`);
  return new Date(timestamp).toISOString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function assertAbsent(path) {
  try {
    await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  fail(`refusing to overwrite existing release material: ${path}`);
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = argumentsMap(process.argv.slice(2));
const publicDirectory = resolve(required(args, "public-dir"));
const privateDirectoryValue = required(args, "private-dir");
if (!isAbsolute(privateDirectoryValue)) {
  fail("--private-dir must be an absolute path outside the repository");
}
const privateDirectory = resolve(privateDirectoryValue);
const privateRelative = relative(repositoryRoot, privateDirectory);
if (
  privateRelative === "" ||
  (!privateRelative.startsWith(`..${sep}`) && privateRelative !== "..")
) {
  fail("--private-dir must be outside the public repository");
}

const issuedAt = isoDate(required(args, "issued-at"), "--issued-at");
const expiresAt = isoDate(required(args, "expires-at"), "--expires-at");
if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
  fail("--expires-at must be later than --issued-at");
}
const recoveryKeyId = required(args, "recovery-key-id");
const releaseKeyId = required(args, "release-key-id");
const keysetVersion = Number.parseInt(required(args, "keyset-version"), 10);
if (!Number.isSafeInteger(keysetVersion) || keysetVersion <= 0) {
  fail("--keyset-version must be a positive integer");
}

const rootsPath = resolve(publicDirectory, "recovery-roots.json");
const keysetPath = resolve(publicDirectory, "release-keyset.json");
const recoveryPrivatePath = resolve(
  privateDirectory,
  `${recoveryKeyId}.private.pem`,
);
const releasePrivatePath = resolve(
  privateDirectory,
  `${releaseKeyId}.seed.json`,
);
await Promise.all(
  [rootsPath, keysetPath, recoveryPrivatePath, releasePrivatePath].map(
    assertAbsent,
  ),
);

const recovery = generateKeyPairSync("ed25519");
const release = generateKeyPairSync("ed25519");
const releasePrivateJwk = release.privateKey.export({ format: "jwk" });
if (
  releasePrivateJwk.kty !== "OKP" ||
  releasePrivateJwk.crv !== "Ed25519" ||
  typeof releasePrivateJwk.d !== "string"
) {
  fail("generated release key is not an Ed25519 private key");
}
const roots = {
  schema_version: 1,
  roots: [
    {
      key_id: recoveryKeyId,
      public_key_pem: publicPem(recovery.publicKey),
    },
  ],
};
const unsignedKeyset = {
  keyset_version: keysetVersion,
  purpose: "release",
  issued_at: issuedAt,
  expires_at: expiresAt,
  keys: [
    {
      key_id: releaseKeyId,
      status: "current",
      public_key_pem: publicPem(release.publicKey),
      not_before: issuedAt,
      not_after: expiresAt,
    },
  ],
  signature: {
    algorithm: "Ed25519",
    key_id: recoveryKeyId,
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
const rootsJson = `${JSON.stringify(roots, null, 2)}\n`;
const keysetJson = `${JSON.stringify(keyset, null, 2)}\n`;
const recoveryPrivatePem = recovery.privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString();
const releasePrivateJson = `${JSON.stringify({
  schema_version: "creatorcut-release-private/1.0",
  key_id: releaseKeyId,
  seed_base64url: releasePrivateJwk.d,
})}\n`;

await mkdir(publicDirectory, { recursive: true, mode: 0o755 });
await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
await chmod(privateDirectory, 0o700);
await Promise.all([
  writeFile(rootsPath, rootsJson, { encoding: "utf8", mode: 0o644 }),
  writeFile(keysetPath, keysetJson, { encoding: "utf8", mode: 0o644 }),
  writeFile(recoveryPrivatePath, recoveryPrivatePem, {
    encoding: "utf8",
    mode: 0o600,
  }),
  writeFile(releasePrivatePath, releasePrivateJson, {
    encoding: "utf8",
    mode: 0o600,
  }),
]);
await Promise.all([
  chmod(recoveryPrivatePath, 0o600),
  chmod(releasePrivatePath, 0o600),
]);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    keyset_version: keysetVersion,
    recovery_key_id: recoveryKeyId,
    release_key_id: releaseKeyId,
    public_files: [rootsPath, keysetPath],
    private_directory: privateDirectory,
    recovery_roots_sha256: sha256(rootsJson),
    release_keyset_sha256: sha256(keysetJson),
  })}\n`,
);
