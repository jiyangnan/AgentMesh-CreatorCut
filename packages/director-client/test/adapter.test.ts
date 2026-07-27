import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  digestJcs,
  envelopeSigningBytes,
  keysetSigningBytes,
  type CostQuote,
  type DirectorContext,
  type DirectorEnvelope,
  type EditDecisionManifest,
  type EditReviewDecisionSet,
  type EditReviewPlan,
  type SemanticDecisionCardSet,
  type SignedArtifactKeyset,
} from "@agentmesh/creatorcut-protocol";
import {
  approveDirectorContext,
  buildDirectorContext,
  createCreatorCutProject,
  openCreatorCutProject,
  readDirectorState,
  writeDirectorState,
  type CreateLocalProjectInput,
} from "@agentmesh/creatorcut-runtime";

import {
  CloudDirectorAdapter,
  type DirectorGenerationView,
  type PublicDirectorState,
} from "../src/index.js";

function signingFixture(): {
  keyset: SignedArtifactKeyset;
  roots: ReadonlyMap<string, string>;
  directorPrivateKey: KeyObject;
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
    directorPrivateKey: director.privateKey,
    roots: new Map([
      [
        "recovery-root-1",
        root.publicKey.export({ format: "pem", type: "spki" }).toString(),
      ],
    ]),
  };
}

interface Cycle3Fixture {
  fixed_clock: { manifest: string; review_decision: string };
  director_context: DirectorContext;
  local_snapshot: {
    project: CreateLocalProjectInput["project"];
    timeline: CreateLocalProjectInput["timeline"];
    transcript: NonNullable<CreateLocalProjectInput["transcript"]>;
    edit_brief: NonNullable<CreateLocalProjectInput["editBrief"]>;
    synthetic_media_stub_utf8: string;
  };
  envelope_chain: {
    direction_card: DirectorEnvelope<SemanticDecisionCardSet>;
    quote: DirectorEnvelope<CostQuote>;
    review_plan: DirectorEnvelope<EditReviewPlan>;
    manifest: DirectorEnvelope<EditDecisionManifest>;
  };
}

async function readCycle3Fixture(): Promise<Cycle3Fixture> {
  return JSON.parse(
    await readFile(
      new URL(
        "../../../tests/fixtures/cycle3-closeout-v1/cycle3-closeout-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Cycle3Fixture;
}

async function cycle3Project(): Promise<{
  directory: string;
  context: DirectorContext;
  fixture: Cycle3Fixture;
}> {
  const fixture = await readCycle3Fixture();
  const root = await mkdtemp(join(tmpdir(), "creatorcut-director-a4-"));
  const directory = join(root, "fixture.creatorcut");
  await createCreatorCutProject(directory, {
    project: fixture.local_snapshot.project,
    timeline: fixture.local_snapshot.timeline,
    transcript: fixture.local_snapshot.transcript,
    editBrief: fixture.local_snapshot.edit_brief,
  });
  await mkdir(join(directory, "media"), { recursive: true });
  await writeFile(
    join(directory, "media", "source.mp4"),
    fixture.local_snapshot.synthetic_media_stub_utf8,
  );
  const opened = await openCreatorCutProject(directory);
  const context = buildDirectorContext(opened, { hostType: "text" });
  expect(context).toEqual(fixture.director_context);
  await approveDirectorContext(opened, context);
  return { directory, context, fixture };
}

function resignEnvelope<T>(
  value: DirectorEnvelope<T>,
  privateKey: KeyObject,
): DirectorEnvelope<T> {
  const unsigned = structuredClone(value);
  unsigned.signature = {
    algorithm: "Ed25519",
    key_id: "director-current-1",
    value: "",
  };
  const signature = sign(null, envelopeSigningBytes(unsigned), privateKey);
  return {
    ...unsigned,
    signature: {
      ...unsigned.signature,
      value: signature.toString("base64"),
    },
  };
}

function directorState(
  context: DirectorContext,
  fixture: Cycle3Fixture,
  reviewEnvelope: DirectorEnvelope<EditReviewPlan>,
  manifestEnvelope: DirectorEnvelope<EditDecisionManifest>,
): PublicDirectorState {
  if (!manifestEnvelope.generation_id) {
    throw new Error("Cycle 3 fixture Manifest is missing generation_id");
  }
  return {
    schema_version: "creatorcut-public-director-state/1.0",
    project_id: context.project_id,
    base_revision: context.base_revision,
    planning_input_digest: digestJcs(context),
    session_id: manifestEnvelope.session_id,
    account_ref: manifestEnvelope.account_ref,
    quote_envelope: fixture.envelope_chain.quote,
    generation_id: manifestEnvelope.generation_id,
    review_envelope: reviewEnvelope,
    manifest_envelope: manifestEnvelope,
    updated_at: fixture.fixed_clock.manifest,
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

  it("retries a lost session-create response and persists the server-deduplicated session", async () => {
    const signing = signingFixture();
    const { directory, context, fixture } = await cycle3Project();
    const opened = await openCreatorCutProject(directory);
    const directionEnvelope = resignEnvelope(
      fixture.envelope_chain.direction_card,
      signing.directorPrivateKey,
    );
    const session = {
      session_id: directionEnvelope.session_id,
      project_id: context.project_id,
      base_revision: context.base_revision,
      planning_input_digest: digestJcs(context),
      state: "active",
      stage: "direction",
      state_revision: 0,
      answer_chain_digest: directionEnvelope.answer_chain_digest,
      current_card_envelope: directionEnvelope,
    };
    let sessionCreateAttempts = 0;
    const adapter = new CloudDirectorAdapter({
      endpoint: "https://director.example.test",
      apiKey: "am_test_key",
      protocolBundleDigest: `sha256:${"a".repeat(64)}`,
      signedKeyset: signing.keyset,
      trustedRecoveryRoots: signing.roots,
      now: () => new Date(fixture.fixed_clock.manifest),
      transport: async (request) => {
        if (request.path === "/v1/director/preflight") {
          return {
            product_id: "creatorcut",
            protocol_version: "1.0",
            protocol_bundle_digest: `sha256:${"a".repeat(64)}`,
            compatible: true,
            action_code: "creatorcut.director.plan",
            cost: 50,
            core_enabled: true,
            accepting_new_generations: true,
          };
        }
        if (
          request.method === "POST" &&
          request.path === "/v1/director/sessions"
        ) {
          sessionCreateAttempts += 1;
          expect(request.body).toEqual(context);
          if (sessionCreateAttempts === 1) {
            throw new Error("session response lost after server commit");
          }
          return session;
        }
        throw new Error(`Unexpected Director request: ${request.path}`);
      },
    });

    await expect(
      adapter.start({ projectDirectory: directory }),
    ).rejects.toThrow(/response lost/u);
    expect(
      (await readDirectorState<PublicDirectorState>(opened))?.session_id,
    ).toBeUndefined();

    await expect(
      adapter.start({ projectDirectory: directory }),
    ).resolves.toMatchObject({
      session_id: session.session_id,
      session_stage: "direction",
      state_revision: 0,
    });
    expect(sessionCreateAttempts).toBe(2);
    expect(
      (await readDirectorState<PublicDirectorState>(opened))?.session_id,
    ).toBe(session.session_id);
  });

  it("verifies the full Manifest chain and every signed input or identifier binding", async () => {
    const signing = signingFixture();
    const { directory, context, fixture } = await cycle3Project();
    const opened = await openCreatorCutProject(directory);
    const review = resignEnvelope(
      fixture.envelope_chain.review_plan,
      signing.directorPrivateKey,
    );
    const manifestValue = structuredClone(fixture.envelope_chain.manifest);
    manifestValue.previous_envelope_digest = digestJcs(review);
    manifestValue.sequence = review.sequence + 1;
    const manifest = resignEnvelope(manifestValue, signing.directorPrivateKey);
    const state = directorState(context, fixture, review, manifest);
    const adapter = new CloudDirectorAdapter({
      endpoint: "https://director.example.test",
      apiKey: "am_test_key",
      protocolBundleDigest: `sha256:${"a".repeat(64)}`,
      signedKeyset: signing.keyset,
      trustedRecoveryRoots: signing.roots,
      now: () => new Date(fixture.fixed_clock.manifest),
      transport: async () => {
        throw new Error("Director transport must not be called");
      },
    });

    await writeDirectorState(opened, state);
    await expect(adapter.getVerifiedManifest(directory)).resolves.toEqual(
      manifest,
    );

    const mismatches: Array<
      [string, (value: DirectorEnvelope<EditDecisionManifest>) => void]
    > = [
      ["sequence", (value) => (value.sequence += 1)],
      [
        "previous envelope",
        (value) =>
          (value.previous_envelope_digest = `sha256:${"0".repeat(64)}`),
      ],
      ["project", (value) => (value.project_id = "project-other")],
      ["revision", (value) => (value.base_revision += 1)],
      [
        "planning input",
        (value) => (value.planning_input_digest = `sha256:${"1".repeat(64)}`),
      ],
      [
        "transcript",
        (value) => (value.transcript_digest = `sha256:${"2".repeat(64)}`),
      ],
      [
        "timeline",
        (value) => (value.timeline_digest = `sha256:${"3".repeat(64)}`),
      ],
      [
        "edit brief",
        (value) => (value.edit_brief_digest = `sha256:${"4".repeat(64)}`),
      ],
      [
        "capabilities",
        (value) => (value.capabilities_digest = `sha256:${"5".repeat(64)}`),
      ],
      ["session", (value) => (value.session_id = "session-other")],
      ["generation", (value) => (value.generation_id = "generation-other")],
      ["quote", (value) => (value.quote_id = "quote-other")],
      ["account", (value) => (value.account_ref = "account-other")],
    ];
    for (const [name, mutate] of mismatches) {
      const changed = structuredClone(manifestValue);
      mutate(changed);
      const signedChanged = resignEnvelope(changed, signing.directorPrivateKey);
      await writeDirectorState(opened, {
        ...state,
        manifest_envelope: signedChanged,
      });
      await expect(
        adapter.getVerifiedManifest(directory),
        name,
      ).rejects.toThrow(/binding mismatch/u);
    }
  });

  it("polls boundedly until asynchronous finalization returns a signed Manifest", async () => {
    const signing = signingFixture();
    const { directory, context, fixture } = await cycle3Project();
    const opened = await openCreatorCutProject(directory);
    const review = resignEnvelope(
      fixture.envelope_chain.review_plan,
      signing.directorPrivateKey,
    );
    const manifestValue = structuredClone(fixture.envelope_chain.manifest);
    manifestValue.previous_envelope_digest = digestJcs(review);
    manifestValue.sequence = review.sequence + 1;
    const manifest = resignEnvelope(manifestValue, signing.directorPrivateKey);
    const generationId = manifest.generation_id!;
    await writeDirectorState(opened, {
      schema_version: "creatorcut-public-director-state/1.0",
      project_id: context.project_id,
      base_revision: context.base_revision,
      planning_input_digest: digestJcs(context),
      session_id: manifest.session_id,
      account_ref: manifest.account_ref,
      quote_envelope: fixture.envelope_chain.quote,
      generation_id: generationId,
      review_envelope: review,
      updated_at: fixture.fixed_clock.manifest,
    });
    const decisions: EditReviewDecisionSet = {
      schema_version: "1.0",
      decision_set_id: "decisions-polling",
      generation_id: generationId,
      review_plan_id: review.payload.review_plan_id,
      review_plan_digest: digestJcs(review.payload),
      project_id: context.project_id,
      base_revision: context.base_revision,
      decisions: review.payload.suggestions.map((suggestion) => ({
        suggestion_id: suggestion.suggestion_id,
        decision: suggestion.default_decision,
      })),
      confirmed_at: fixture.fixed_clock.review_decision,
    };
    let gets = 0;
    const baseGeneration = {
      generation_id: generationId,
      session_id: manifest.session_id,
      project_id: context.project_id,
      base_revision: context.base_revision,
      planning_input_digest: digestJcs(context),
      quote_id: fixture.envelope_chain.quote.payload.quote_id,
      attempt: 1,
    };
    const adapter = new CloudDirectorAdapter({
      endpoint: "https://director.example.test",
      apiKey: "am_test_key",
      protocolBundleDigest: `sha256:${"a".repeat(64)}`,
      signedKeyset: signing.keyset,
      trustedRecoveryRoots: signing.roots,
      now: () => new Date(fixture.fixed_clock.manifest),
      finalizePollIntervalMs: 0,
      finalizePollAttempts: 3,
      sleep: async () => undefined,
      transport: async (request) => {
        if (request.path.endsWith("/review-decisions")) {
          return { ...baseGeneration, state: "awaiting_review" };
        }
        if (request.method === "POST" && request.path.endsWith("/finalize")) {
          return { ...baseGeneration, state: "finalizing" };
        }
        if (request.method === "GET") {
          gets += 1;
          return gets === 1
            ? { ...baseGeneration, state: "signing" }
            : {
                ...baseGeneration,
                state: "ready",
                manifest_envelope: manifest,
              };
        }
        throw new Error(`Unexpected Director request: ${request.path}`);
      },
    });

    await expect(adapter.finalize(directory, { decisions })).resolves.toEqual(
      manifest,
    );
    expect(gets).toBe(2);
  });

  it("persists and reuses the Generation ID across a lost create response", async () => {
    const signing = signingFixture();
    const { directory, context, fixture } = await cycle3Project();
    const opened = await openCreatorCutProject(directory);
    const quote = fixture.envelope_chain.quote;
    const generationId = "generation-response-loss-a4";
    const state: PublicDirectorState = {
      schema_version: "creatorcut-public-director-state/1.0",
      project_id: context.project_id,
      base_revision: context.base_revision,
      planning_input_digest: digestJcs(context),
      session_id: quote.session_id,
      account_ref: quote.account_ref,
      quote_envelope: quote,
      updated_at: fixture.fixed_clock.manifest,
    };
    await writeDirectorState(opened, state);
    const postIds: string[] = [];
    let getAttempts = 0;
    const generation: DirectorGenerationView = {
      generation_id: generationId,
      session_id: quote.session_id,
      project_id: context.project_id,
      base_revision: context.base_revision,
      planning_input_digest: digestJcs(context),
      quote_id: quote.payload.quote_id,
      state: "queued",
      attempt: 0,
    };
    const adapter = new CloudDirectorAdapter({
      endpoint: "https://director.example.test",
      apiKey: "am_test_key",
      protocolBundleDigest: `sha256:${"a".repeat(64)}`,
      signedKeyset: signing.keyset,
      trustedRecoveryRoots: signing.roots,
      now: () => new Date(fixture.fixed_clock.manifest),
      uuid: () => generationId,
      transport: async (request) => {
        if (
          request.method === "POST" &&
          request.path.endsWith("/generations")
        ) {
          const body = request.body as { generation_id: string };
          postIds.push(body.generation_id);
          if (postIds.length === 1) throw new Error("response lost");
          return generation;
        }
        if (
          request.method === "GET" &&
          request.path === `/v1/director/generations/${generationId}`
        ) {
          getAttempts += 1;
          throw new Error("Generation is not visible yet");
        }
        throw new Error(`Unexpected Director request: ${request.path}`);
      },
    });

    await expect(
      adapter.generate({
        projectDirectory: directory,
        confirmationId: "confirmation-a4",
      }),
    ).rejects.toThrow(/response lost/u);
    expect(
      (await readDirectorState<PublicDirectorState>(opened))?.generation_id,
    ).toBe(generationId);

    await expect(
      adapter.generate({
        projectDirectory: directory,
        confirmationId: "confirmation-a4",
      }),
    ).resolves.toEqual(generation);
    expect(postIds).toEqual([generationId, generationId]);
    expect(getAttempts).toBe(1);
  });

  it("rejects a Generation response with a different stable identifier", async () => {
    const signing = signingFixture();
    const { directory, context, fixture } = await cycle3Project();
    const opened = await openCreatorCutProject(directory);
    const quote = fixture.envelope_chain.quote;
    await writeDirectorState(opened, {
      schema_version: "creatorcut-public-director-state/1.0",
      project_id: context.project_id,
      base_revision: context.base_revision,
      planning_input_digest: digestJcs(context),
      session_id: quote.session_id,
      account_ref: quote.account_ref,
      quote_envelope: quote,
      updated_at: fixture.fixed_clock.manifest,
    } satisfies PublicDirectorState);
    const adapter = new CloudDirectorAdapter({
      endpoint: "https://director.example.test",
      apiKey: "am_test_key",
      protocolBundleDigest: `sha256:${"a".repeat(64)}`,
      signedKeyset: signing.keyset,
      trustedRecoveryRoots: signing.roots,
      now: () => new Date(fixture.fixed_clock.manifest),
      uuid: () => "generation-expected",
      transport: async () => ({
        generation_id: "generation-other",
        session_id: quote.session_id,
        project_id: context.project_id,
        base_revision: context.base_revision,
        planning_input_digest: digestJcs(context),
        quote_id: quote.payload.quote_id,
        state: "queued",
        attempt: 0,
      }),
    });

    await expect(
      adapter.generate({
        projectDirectory: directory,
        confirmationId: "confirmation-a4",
      }),
    ).rejects.toThrow(/Generation binding mismatch/u);
  });
});
