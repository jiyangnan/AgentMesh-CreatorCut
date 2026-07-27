#!/usr/bin/env node

import { createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

const loneSurrogate =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function fail(message) {
  process.stderr.write(`CreatorCut release verification failed: ${message}\n`);
  process.exit(1);
}

function serialize(value, path, ancestors) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    if (loneSurrogate.test(value)) fail(`${path} contains invalid Unicode`);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${path} contains a non-finite number`);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") fail(`${path} contains a non-JSON value`);
  if (ancestors.has(value)) fail(`${path} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((entry, index) => serialize(entry, `${path}/${index}`, ancestors))
        .join(",")}]`;
    }
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        if (loneSurrogate.test(key)) fail(`${path} contains an invalid key`);
        return `${JSON.stringify(key)}:${serialize(
          value[key],
          `${path}/${key}`,
          ancestors,
        )}`;
      })
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalize(value) {
  return serialize(value, "$", new Set());
}

function argumentsMap(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      fail("arguments must be --name value pairs");
    }
    result.set(name.slice(2), value);
  }
  return result;
}

async function jsonFile(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(`${label} is missing or invalid JSON`);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function requireString(value, name, label) {
  const field = value[name];
  if (typeof field !== "string" || field.length === 0) {
    fail(`${label}.${name} is invalid`);
  }
  return field;
}

function verifySignature(bytes, signature, publicKeyPem, label) {
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    fail(`${label} public key is invalid`);
  }
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    !verify(
      null,
      Buffer.from(bytes),
      publicKey,
      Buffer.from(signature, "base64"),
    )
  ) {
    fail(`${label} signature is invalid`);
  }
}

const args = argumentsMap(process.argv.slice(2));
const manifest = requireObject(
  await jsonFile(args.get("manifest"), "ReleaseManifest"),
  "ReleaseManifest",
);
const keyset = requireObject(
  await jsonFile(args.get("keyset"), "release keyset"),
  "release keyset",
);
const rootsFile = requireObject(
  await jsonFile(args.get("recovery-roots"), "recovery roots"),
  "recovery roots",
);
const now = Date.parse(args.get("now") ?? new Date().toISOString());
const minimumKeysetVersion = Number.parseInt(
  args.get("minimum-keyset-version") ?? "1",
  10,
);

if (
  rootsFile.schema_version !== 1 ||
  !Array.isArray(rootsFile.roots) ||
  rootsFile.roots.length === 0
) {
  fail("recovery roots are invalid");
}
const roots = new Map();
for (const entry of rootsFile.roots) {
  const root = requireObject(entry, "recovery root");
  const keyId = requireString(root, "key_id", "recovery root");
  const publicKeyPem = requireString(root, "public_key_pem", "recovery root");
  if (roots.has(keyId)) fail("recovery root ids must be unique");
  roots.set(keyId, publicKeyPem);
}

if (
  keyset.purpose !== "release" ||
  !Number.isSafeInteger(keyset.keyset_version) ||
  keyset.keyset_version < minimumKeysetVersion ||
  !Array.isArray(keyset.keys) ||
  keyset.keys.length === 0
) {
  fail("release keyset purpose, version, or keys are invalid");
}
const keysetIssuedAt = Date.parse(requireString(keyset, "issued_at", "keyset"));
const keysetExpiresAt = Date.parse(
  requireString(keyset, "expires_at", "keyset"),
);
if (!Number.isFinite(now) || now < keysetIssuedAt || now > keysetExpiresAt) {
  fail("release keyset is outside its validity window");
}
const keysetSignature = requireObject(keyset.signature, "keyset.signature");
if (keysetSignature.algorithm !== "Ed25519") {
  fail("release keyset signature algorithm is invalid");
}
const recoveryKeyId = requireString(
  keysetSignature,
  "key_id",
  "keyset.signature",
);
const recoveryKey = roots.get(recoveryKeyId);
if (!recoveryKey) fail("release keyset recovery root is unknown");
const keysetSigningValue = {
  ...keyset,
  signature: {
    algorithm: "Ed25519",
    key_id: recoveryKeyId,
  },
};
verifySignature(
  canonicalize(keysetSigningValue),
  requireString(keysetSignature, "value", "keyset.signature"),
  recoveryKey,
  "release keyset",
);

const expectedManifestFields = new Set([
  "artifact_sha256",
  "channel",
  "git_commit",
  "git_tag",
  "key_id",
  "latest_client_version",
  "minimum_supported_version",
  "notes_url",
  "product",
  "protocol_version",
  "published_at",
  "required",
  "signature",
  "signature_algorithm",
]);
if (
  Object.keys(manifest).length !== expectedManifestFields.size ||
  Object.keys(manifest).some((field) => !expectedManifestFields.has(field))
) {
  fail("ReleaseManifest fields are invalid");
}
const latestVersion = requireString(
  manifest,
  "latest_client_version",
  "ReleaseManifest",
);
const minimumVersion = requireString(
  manifest,
  "minimum_supported_version",
  "ReleaseManifest",
);
const gitTag = requireString(manifest, "git_tag", "ReleaseManifest");
const gitCommit = requireString(manifest, "git_commit", "ReleaseManifest");
const artifactSha256 = requireString(
  manifest,
  "artifact_sha256",
  "ReleaseManifest",
);
if (
  manifest.product !== "creatorcut" ||
  manifest.channel !== "stable" ||
  manifest.protocol_version !== "1.0" ||
  manifest.signature_algorithm !== "Ed25519" ||
  typeof manifest.required !== "boolean" ||
  !/^\d+\.\d+\.\d+$/u.test(latestVersion) ||
  !/^\d+\.\d+\.\d+$/u.test(minimumVersion) ||
  gitTag !== `v${latestVersion}` ||
  !/^[0-9a-f]{40}$/u.test(gitCommit) ||
  !/^[0-9a-f]{64}$/u.test(artifactSha256)
) {
  fail("ReleaseManifest identity is invalid");
}
const notesUrl = new URL(
  requireString(manifest, "notes_url", "ReleaseManifest"),
);
if (notesUrl.protocol !== "https:") {
  fail("ReleaseManifest notes URL must use HTTPS");
}
const releaseKeyId = requireString(manifest, "key_id", "ReleaseManifest");
const releaseKey = keyset.keys.find((entry) => entry.key_id === releaseKeyId);
const publishedAt = Date.parse(
  requireString(manifest, "published_at", "ReleaseManifest"),
);
if (
  !releaseKey ||
  releaseKey.status === "revoked" ||
  publishedAt < Date.parse(releaseKey.not_before) ||
  publishedAt > Date.parse(releaseKey.not_after) ||
  publishedAt > now + 5 * 60 * 1000
) {
  fail("ReleaseManifest signing key is unknown, revoked, or inactive");
}
const { signature, ...unsignedManifest } = manifest;
verifySignature(
  canonicalize(unsignedManifest),
  requireString({ signature }, "signature", "ReleaseManifest"),
  requireString(releaseKey, "public_key_pem", "release key"),
  "ReleaseManifest",
);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    product: "creatorcut",
    version: latestVersion,
    git_tag: gitTag,
    git_commit: gitCommit,
    artifact_sha256: artifactSha256,
    release_keyset_version: keyset.keyset_version,
  })}\n`,
);
