import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  verifySignedKeyset,
  type SignedArtifactKeyset,
} from "@agentmesh/creatorcut-protocol";

interface RecoveryRootsFile {
  schema_version: 1;
  roots: Array<{ key_id: string; public_key_pem: string }>;
}

export async function loadVerifiedDirectorKeyset(input: {
  keysetPath: string;
  recoveryRootsPath: string;
  minimumVersion?: number;
  now?: Date;
}): Promise<{
  keyset: SignedArtifactKeyset;
  roots: ReadonlyMap<string, string>;
}> {
  const [keysetValue, rootsValue] = await Promise.all([
    readFile(input.keysetPath, "utf8").then(
      (contents) => JSON.parse(contents) as unknown,
    ),
    readFile(input.recoveryRootsPath, "utf8").then(
      (contents) => JSON.parse(contents) as unknown,
    ),
  ]);
  if (
    rootsValue === null ||
    typeof rootsValue !== "object" ||
    Array.isArray(rootsValue) ||
    (rootsValue as Record<string, unknown>).schema_version !== 1 ||
    !Array.isArray((rootsValue as Record<string, unknown>).roots)
  ) {
    throw new TypeError("CreatorCut recovery roots file is invalid");
  }
  const roots = new Map<string, string>();
  for (const root of (rootsValue as RecoveryRootsFile).roots) {
    if (
      !root ||
      typeof root.key_id !== "string" ||
      !root.key_id ||
      typeof root.public_key_pem !== "string" ||
      !root.public_key_pem ||
      roots.has(root.key_id) ||
      createPublicKey(root.public_key_pem).asymmetricKeyType !== "ed25519"
    ) {
      throw new TypeError("CreatorCut recovery roots file is invalid");
    }
    roots.set(root.key_id, root.public_key_pem);
  }
  if (roots.size === 0) {
    throw new TypeError("CreatorCut recovery roots file is empty");
  }
  const keyset = verifySignedKeyset(keysetValue, roots, {
    purpose: "director",
    ...(input.minimumVersion === undefined
      ? {}
      : { minimumVersion: input.minimumVersion }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return { keyset, roots };
}
