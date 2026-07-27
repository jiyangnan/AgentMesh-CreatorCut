#!/usr/bin/env node
import { resolve } from "node:path";

import { KeychainCredentialStore } from "@agentmesh/creatorcut-credentials";
import {
  CloudDirectorAdapter,
  loadVerifiedDirectorKeyset,
} from "@agentmesh/creatorcut-director-client";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { PublicClientCapabilities } from "@agentmesh/creatorcut-protocol";

import { createCreatorCutMcpServer } from "./server.js";
import { CreatorCutMcpService } from "./service.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for remote Director tools`);
  return value;
}

let adapterPromise: Promise<CloudDirectorAdapter> | undefined;
const hostTypeValue = process.env.CREATORCUT_HOST_TYPE ?? "text";
if (!["codex", "claude_code", "openclaw", "text"].includes(hostTypeValue)) {
  throw new Error("CREATORCUT_HOST_TYPE is invalid");
}
const hostType = hostTypeValue as PublicClientCapabilities["host_type"];
function getAdapter(): Promise<CloudDirectorAdapter> {
  adapterPromise ??= (async () => {
    const apiKey = await new KeychainCredentialStore().getApiKey();
    if (!apiKey) throw new Error("Run creatorcut auth login first");
    const minimumVersionValue = process.env.CREATORCUT_MINIMUM_KEYSET_VERSION;
    const minimumVersion =
      minimumVersionValue === undefined
        ? undefined
        : Number.parseInt(minimumVersionValue, 10);
    if (
      minimumVersion !== undefined &&
      (!Number.isSafeInteger(minimumVersion) || minimumVersion <= 0)
    ) {
      throw new Error("CREATORCUT_MINIMUM_KEYSET_VERSION is invalid");
    }
    const trust = await loadVerifiedDirectorKeyset({
      keysetPath: requiredEnvironment("CREATORCUT_DIRECTOR_KEYSET"),
      recoveryRootsPath: requiredEnvironment(
        "CREATORCUT_DIRECTOR_RECOVERY_ROOTS",
      ),
      ...(minimumVersion === undefined ? {} : { minimumVersion }),
    });
    return new CloudDirectorAdapter({
      endpoint: requiredEnvironment("CREATORCUT_DIRECTOR_ENDPOINT"),
      apiKey,
      protocolBundleDigest: requiredEnvironment(
        "CREATORCUT_PROTOCOL_BUNDLE_DIGEST",
      ),
      signedKeyset: trust.keyset,
      trustedRecoveryRoots: trust.roots,
      hostType: "text",
      ...(minimumVersion === undefined
        ? {}
        : { minimumKeysetVersion: minimumVersion }),
    });
  })();
  return adapterPromise;
}

const projectDirectory = resolve(
  argument("--project") ?? process.env.CREATORCUT_PROJECT ?? process.cwd(),
);
const service = new CreatorCutMcpService(
  projectDirectory,
  getAdapter,
  hostType,
);
const server = createCreatorCutMcpServer(service);
await server.connect(new StdioServerTransport());
