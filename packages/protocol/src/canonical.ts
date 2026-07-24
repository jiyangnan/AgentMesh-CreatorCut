import { createHash, createPublicKey, verify } from "node:crypto";

import type {
  DirectorEnvelope,
  SignatureBlock,
  SignedArtifactKeyset,
} from "./types.js";

const loneSurrogate =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function assertUnicode(value: string, path: string): void {
  if (loneSurrogate.test(value)) {
    throw new TypeError(`${path} contains an unpaired UTF-16 surrogate`);
  }
}

function serialize(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertUnicode(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} contains a non-finite number`);
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} contains a non-JSON value`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} contains a cycle`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new TypeError(`${path}/${index} is a sparse array entry`);
        }
      }
      return `[${value
        .map((entry, index) => {
          return serialize(entry, `${path}/${index}`, ancestors);
        })
        .join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} contains a non-plain object`);
    }

    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => {
        assertUnicode(key, `${path}/<key>`);
        return `${JSON.stringify(key)}:${serialize(
          record[key],
          `${path}/${key}`,
          ancestors,
        )}`;
      })
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeJcs(value: unknown): string {
  return serialize(value, "$", new Set());
}

export function digestJcs(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalizeJcs(value), "utf8")
    .digest("hex")}`;
}

function signingBlock(
  signature: SignatureBlock,
): Omit<SignatureBlock, "value"> {
  return {
    algorithm: signature.algorithm,
    key_id: signature.key_id,
  };
}

export function envelopeSigningBytes<T>(
  envelope: DirectorEnvelope<T>,
): Uint8Array {
  return Buffer.from(
    canonicalizeJcs({
      ...envelope,
      signature: signingBlock(envelope.signature),
    }),
    "utf8",
  );
}

export function keysetSigningBytes(keyset: SignedArtifactKeyset): Uint8Array {
  return Buffer.from(
    canonicalizeJcs({
      ...keyset,
      signature: signingBlock(keyset.signature),
    }),
    "utf8",
  );
}

export function verifyEd25519(
  bytes: Uint8Array,
  signatureBase64: string,
  publicKeyPem: string,
): boolean {
  return verify(
    null,
    bytes,
    createPublicKey(publicKeyPem),
    Buffer.from(signatureBase64, "base64"),
  );
}
