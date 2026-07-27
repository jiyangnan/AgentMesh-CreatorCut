import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  keysetSigningBytes,
  type SignedArtifactKeyset,
} from "@agentmesh/creatorcut-protocol";

import { CloudDirectorAdapter } from "../src/index.js";

function signingFixture(): {
  keyset: SignedArtifactKeyset;
  roots: ReadonlyMap<string, string>;
} {
  const root = generateKeyPairSync("ed25519");
  const director = generateKeyPairSync("ed25519");
  const now = Date.parse("2026-07-27T00:00:00.000Z");
  const unsigned: SignedArtifactKeyset = {
    keyset_version: 1,
    purpose: "director",
    issued_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 86_400_000).toISOString(),
    keys: [
      {
        key_id: "director-current-1",
        status: "current",
        public_key_pem: director.publicKey
          .export({ format: "pem", type: "spki" })
          .toString(),
        not_before: new Date(now - 60_000).toISOString(),
        not_after: new Date(now + 86_400_000).toISOString(),
      },
    ],
    signature: {
      algorithm: "Ed25519",
      key_id: "recovery-root-1",
      value: "",
    },
  };
  const signature = sign(null, keysetSigningBytes(unsigned), root.privateKey);
  const keyset: SignedArtifactKeyset = {
    ...unsigned,
    signature: {
      ...unsigned.signature,
      value: signature.toString("base64"),
    },
  };
  return {
    keyset,
    roots: new Map([
      [
        "recovery-root-1",
        root.publicKey.export({ format: "pem", type: "spki" }).toString(),
      ],
    ]),
  };
}

describe("CloudDirectorAdapter", () => {
  it("performs a content-free compatibility preflight", async () => {
    const fixture = signingFixture();
    const requests: unknown[] = [];
    const adapter = new CloudDirectorAdapter({
      endpoint: "https://director.example.test",
      apiKey: "am_test_key",
      protocolBundleDigest: `sha256:${"a".repeat(64)}`,
      signedKeyset: fixture.keyset,
      trustedRecoveryRoots: fixture.roots,
      now: () => new Date("2026-07-27T00:00:00.000Z"),
      transport: async (request) => {
        requests.push(request);
        return {
          product_id: "creatorcut",
          protocol_version: "1.0",
          protocol_bundle_digest: `sha256:${"a".repeat(64)}`,
          compatible: true,
          action_code: "creatorcut.director.plan",
          cost: 50,
          core_enabled: false,
          accepting_new_generations: false,
        };
      },
    });

    const value = await adapter.preflight();
    expect(value.cost).toBe(50);
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/v1/director/preflight",
        authenticated: false,
        body: {
          product_id: "creatorcut",
          protocol_bundle_digest: `sha256:${"a".repeat(64)}`,
          host_id: "creatorcut_public_client",
        },
      },
    ]);
  });

  it("rejects plaintext non-loopback Director endpoints", () => {
    const fixture = signingFixture();
    expect(
      () =>
        new CloudDirectorAdapter({
          endpoint: "http://director.example.test",
          apiKey: "am_test_key",
          protocolBundleDigest: `sha256:${"a".repeat(64)}`,
          signedKeyset: fixture.keyset,
          trustedRecoveryRoots: fixture.roots,
          now: () => new Date("2026-07-27T00:00:00.000Z"),
        }),
    ).toThrow(/HTTPS/u);
  });
});
