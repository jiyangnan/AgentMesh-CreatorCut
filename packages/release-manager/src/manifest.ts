import { verifyEd25519, canonicalizeJcs } from "@agentmesh/creatorcut-protocol";

import type {
  ReleaseCheck,
  ReleaseManifest,
  VerifiedReleaseManifest,
  VerifiedReleaseTrust,
} from "./types.js";

const MANIFEST_FIELDS = new Set([
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

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("CreatorCut release manifest must be an object");
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  if (typeof field !== "string" || field.length === 0) {
    throw new TypeError(`CreatorCut release manifest ${name} is invalid`);
  }
  return field;
}

function semanticVersion(
  value: string,
  label: string,
): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (!match)
    throw new TypeError(`CreatorCut ${label} is not semantic version`);
  return [
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10),
    Number.parseInt(match[3]!, 10),
  ];
}

function compareVersion(
  left: [number, number, number],
  right: [number, number, number],
): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export function releaseManifestSigningBytes(
  manifest: ReleaseManifest,
): Uint8Array {
  const { signature: _signature, ...unsigned } = manifest;
  return Buffer.from(canonicalizeJcs(unsigned), "utf8");
}

export function verifyReleaseManifest(
  value: unknown,
  trust: VerifiedReleaseTrust,
  options: {
    now?: Date;
    product?: "creatorcut";
    channel?: "stable";
    protocolVersion?: "1.0";
  } = {},
): VerifiedReleaseManifest {
  const input = record(value);
  const fields = Object.keys(input);
  if (
    fields.length !== MANIFEST_FIELDS.size ||
    fields.some((field) => !MANIFEST_FIELDS.has(field))
  ) {
    throw new TypeError("CreatorCut release manifest fields are invalid");
  }
  const manifest = {
    product: stringField(input, "product"),
    channel: stringField(input, "channel"),
    latest_client_version: stringField(input, "latest_client_version"),
    minimum_supported_version: stringField(input, "minimum_supported_version"),
    protocol_version: stringField(input, "protocol_version"),
    git_tag: stringField(input, "git_tag"),
    git_commit: stringField(input, "git_commit"),
    artifact_sha256: stringField(input, "artifact_sha256"),
    published_at: stringField(input, "published_at"),
    required: input.required,
    notes_url: stringField(input, "notes_url"),
    key_id: stringField(input, "key_id"),
    signature_algorithm: stringField(input, "signature_algorithm"),
    signature: stringField(input, "signature"),
  };
  if (
    manifest.product !== (options.product ?? "creatorcut") ||
    manifest.channel !== (options.channel ?? "stable") ||
    manifest.protocol_version !== (options.protocolVersion ?? "1.0")
  ) {
    throw new TypeError(
      "CreatorCut release manifest product, channel, or protocol mismatch",
    );
  }
  if (
    manifest.signature_algorithm !== "Ed25519" ||
    typeof manifest.required !== "boolean"
  ) {
    throw new TypeError(
      "CreatorCut release manifest signature fields are invalid",
    );
  }
  const latest = semanticVersion(
    manifest.latest_client_version,
    "latest client version",
  );
  const minimum = semanticVersion(
    manifest.minimum_supported_version,
    "minimum supported version",
  );
  if (
    compareVersion(minimum, latest) > 0 ||
    manifest.git_tag !== `v${manifest.latest_client_version}` ||
    !/^[0-9a-f]{40}$/u.test(manifest.git_commit) ||
    !/^[0-9a-f]{64}$/u.test(manifest.artifact_sha256)
  ) {
    throw new TypeError(
      "CreatorCut release manifest release identity is invalid",
    );
  }
  const publishedAt = Date.parse(manifest.published_at);
  const notesUrl = new URL(manifest.notes_url);
  if (
    !Number.isFinite(publishedAt) ||
    notesUrl.protocol !== "https:" ||
    !/^[A-Za-z0-9_-]+={0,2}$/u.test(manifest.signature)
  ) {
    throw new TypeError("CreatorCut release manifest metadata is invalid");
  }
  if (trust.keyset.purpose !== "release") {
    throw new TypeError("CreatorCut ReleaseManifest requires a release keyset");
  }
  const key = trust.keyset.keys.find(
    (candidate) => candidate.key_id === manifest.key_id,
  );
  if (
    !key ||
    key.status === "revoked" ||
    publishedAt < Date.parse(key.not_before) ||
    publishedAt > Date.parse(key.not_after)
  ) {
    throw new TypeError("Unknown, revoked, or inactive CreatorCut release key");
  }
  if (
    !verifyEd25519(
      releaseManifestSigningBytes(manifest as ReleaseManifest),
      manifest.signature,
      key.public_key_pem,
    )
  ) {
    throw new TypeError("Invalid CreatorCut release manifest signature");
  }
  const now = options.now ?? new Date();
  if (publishedAt > now.getTime() + 5 * 60 * 1000) {
    throw new TypeError("CreatorCut release manifest is from the future");
  }
  return manifest as VerifiedReleaseManifest;
}

export async function fetchVerifiedReleaseManifest(input: {
  endpoint: string;
  trust: VerifiedReleaseTrust;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: Date;
}): Promise<VerifiedReleaseManifest> {
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1") {
    throw new TypeError("CreatorCut release endpoint must use HTTPS");
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? 10_000,
  );
  try {
    const response = await (input.fetchImpl ?? fetch)(endpoint, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        `CreatorCut release endpoint returned HTTP ${response.status}`,
      );
    }
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > 256 * 1024) {
      throw new TypeError("CreatorCut release manifest is too large");
    }
    const contents = await response.text();
    if (Buffer.byteLength(contents, "utf8") > 256 * 1024) {
      throw new TypeError("CreatorCut release manifest is too large");
    }
    let value: unknown;
    try {
      value = JSON.parse(contents) as unknown;
    } catch (error) {
      throw new TypeError("CreatorCut release endpoint returned invalid JSON", {
        cause: error,
      });
    }
    return verifyReleaseManifest(value, input.trust, {
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function releaseCheck(
  currentVersion: string,
  manifest: VerifiedReleaseManifest,
): ReleaseCheck {
  const current = semanticVersion(currentVersion, "current client version");
  const latest = semanticVersion(
    manifest.latest_client_version,
    "latest client version",
  );
  if (compareVersion(current, latest) >= 0) {
    return {
      status: "current",
      current_version: currentVersion,
      manifest,
    };
  }
  const minimum = semanticVersion(
    manifest.minimum_supported_version,
    "minimum supported version",
  );
  return {
    status:
      compareVersion(current, minimum) < 0
        ? "update_required"
        : "update_available",
    current_version: currentVersion,
    latest_version: manifest.latest_client_version,
    manifest,
  };
}
