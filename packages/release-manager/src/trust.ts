import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  verifySignedKeyset,
  type SignedArtifactKeyset,
} from "@agentmesh/creatorcut-protocol";

import type { VerifiedReleaseTrust } from "./types.js";

interface RecoveryRootsFile {
  schema_version: 1;
  roots: Array<{ key_id: string; public_key_pem: string }>;
}

function parseRecoveryRoots(value: unknown): ReadonlyMap<string, string> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).schema_version !== 1 ||
    !Array.isArray((value as Record<string, unknown>).roots)
  ) {
    throw new TypeError("CreatorCut release recovery roots file is invalid");
  }
  const roots = new Map<string, string>();
  for (const root of (value as RecoveryRootsFile).roots) {
    if (
      !root ||
      typeof root.key_id !== "string" ||
      root.key_id.length === 0 ||
      typeof root.public_key_pem !== "string" ||
      root.public_key_pem.length === 0 ||
      roots.has(root.key_id) ||
      createPublicKey(root.public_key_pem).asymmetricKeyType !== "ed25519"
    ) {
      throw new TypeError("CreatorCut release recovery roots file is invalid");
    }
    roots.set(root.key_id, root.public_key_pem);
  }
  if (roots.size === 0) {
    throw new TypeError("CreatorCut release recovery roots file is empty");
  }
  return roots;
}

function parseJson(contents: string, label: string): unknown {
  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    throw new TypeError(`${label} is not valid JSON`, { cause: error });
  }
}

export async function loadVerifiedReleaseKeyset(input: {
  keysetPath: string;
  recoveryRootsPath: string;
  minimumVersion?: number;
  now?: Date;
}): Promise<VerifiedReleaseTrust> {
  const [keysetContents, rootsContents] = await Promise.all([
    readFile(input.keysetPath, "utf8"),
    readFile(input.recoveryRootsPath, "utf8"),
  ]);
  const roots = parseRecoveryRoots(
    parseJson(rootsContents, "CreatorCut release recovery roots file"),
  );
  const keyset = verifySignedKeyset(
    parseJson(keysetContents, "CreatorCut release keyset"),
    roots,
    {
      purpose: "release",
      ...(input.minimumVersion === undefined
        ? {}
        : { minimumVersion: input.minimumVersion }),
      ...(input.now === undefined ? {} : { now: input.now }),
    },
  );
  return { keyset, roots };
}

export function verifyReleaseKeyset(input: {
  keyset: unknown;
  recoveryRoots: unknown;
  minimumVersion?: number;
  now?: Date;
}): VerifiedReleaseTrust {
  const roots = parseRecoveryRoots(input.recoveryRoots);
  const keyset: SignedArtifactKeyset = verifySignedKeyset(input.keyset, roots, {
    purpose: "release",
    ...(input.minimumVersion === undefined
      ? {}
      : { minimumVersion: input.minimumVersion }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return { keyset, roots };
}
