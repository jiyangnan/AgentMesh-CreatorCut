import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertCardSetLimits,
  canonicalizeJcs,
  CREATORCUT_LIMITS_V1,
  digestJcs,
  envelopeSigningBytes,
  keysetSigningBytes,
  ProtocolLimitError,
  validatePublicProtocol,
  verifyDirectorEnvelope,
  verifySignedKeyset,
  type CostQuote,
  type DecisionCardAnswerSet,
  type DirectorContext,
  type DirectorEnvelope,
  type EditDecisionManifest,
  type EditReviewPlan,
  type EditReviewDecisionSet,
  type PublicClientCapabilities,
  type SemanticDecisionCardSet,
  type SignedArtifactKeyset,
} from "../src/index.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

const capabilities: PublicClientCapabilities = {
  schema_version: "1.0",
  client_version: "0.1.0",
  host_type: "codex",
  protocol_versions: ["1.0"],
  card_types: ["single", "multi", "text", "visual", "voice", "review"],
  operation_types: ["remove_range", "add_caption"],
  supports_visual_previews: true,
  supports_voice_preview: true,
  max_payload_bytes: 4 * 1024 * 1024,
};

const timeline: DirectorContext["timeline"] = {
  duration_us: 30_000_000,
  canvas: { width: 1920, height: 1080 },
  tracks: [
    {
      track_ref: "track_video",
      kind: "video",
      clips: [
        {
          clip_ref: "clip_primary",
          source_asset_ref: "asset_primary",
          source_start_us: 0,
          source_end_us: 30_000_000,
          timeline_start_us: 0,
          timeline_end_us: 30_000_000,
        },
      ],
    },
  ],
};

const transcript: DirectorContext["transcript"] = {
  language_mode: "mixed",
  text_utf8_bytes: Buffer.byteLength("你好 CreatorCut", "utf8"),
  segment_count: 1,
  token_count: 2,
  silence_intervals: [
    {
      silence_id: "silence_1",
      source_asset_ref: "asset_primary",
      start_us: 2_000_000,
      end_us: 3_000_000,
      detector: "local_audio",
    },
  ],
  segments: [
    {
      segment_id: "segment_1",
      source_asset_ref: "asset_primary",
      start_us: 0,
      end_us: 4_000_000,
      text: "你好 CreatorCut",
      tokens: [
        {
          token_id: "token_zh",
          start_us: 0,
          end_us: 800_000,
          text: "你好",
          language: "zh",
          confidence_millis: 980,
        },
        {
          token_id: "token_en",
          start_us: 1_000_000,
          end_us: 2_000_000,
          text: "CreatorCut",
          language: "en",
          confidence_millis: 970,
        },
      ],
    },
  ],
};

const context: DirectorContext = {
  schema_version: "1.0",
  project_id: "project_1",
  base_revision: 7,
  client_version: capabilities.client_version,
  protocol_versions: ["1.0"],
  consent_version: "director-context-consent-v1",
  project_digest: digest("0"),
  timeline_digest: digestJcs(timeline),
  transcript_digest: digestJcs(transcript),
  edit_brief_digest: digest("6"),
  capabilities_digest: digestJcs(capabilities),
  media: {
    source_asset_ref: "asset_primary",
    duration_us: 30_000_000,
    width: 1920,
    height: 1080,
    has_video: true,
    has_audio: true,
  },
  timeline,
  transcript,
  capabilities,
  local_facts: {
    project_kind: "mixed",
    voice_generation_available: true,
    current_finishing: {
      caption_style_id: "caption_clean",
      lut_id: "lut_none",
      audio_mode: "original",
      background_music: { mode: "none" },
    },
  },
};

const cards: SemanticDecisionCardSet = {
  schema_version: "1.0",
  card_set_id: "cards_direction_1",
  state_revision: 1,
  stage: "direction",
  cards: [
    {
      card_id: "platform",
      type: "single",
      title: "发布平台",
      prompt: "这条视频准备发布在哪里？",
      required: true,
      default_option_ids: ["xiaohongshu"],
      options: [
        {
          option_id: "xiaohongshu",
          label: "小红书",
        },
      ],
    },
  ],
};

const answers: DecisionCardAnswerSet = {
  schema_version: "1.0",
  answer_set_id: "answers_direction_1",
  card_set_id: cards.card_set_id,
  card_set_digest: digestJcs(cards),
  presentation_digest: digest("a"),
  capabilities_digest: digestJcs(capabilities),
  planning_input_digest: digest("1"),
  previous_envelope_digest: digest("b"),
  project_id: "project_1",
  base_revision: 7,
  state_revision: 1,
  answers: [
    {
      card_id: "platform",
      selected_option_ids: ["xiaohongshu"],
    },
  ],
};

const quote: CostQuote = {
  schema_version: "1.0",
  quote_id: "quote_1",
  action_code: "creatorcut.director.plan",
  cost: 10,
  planning_input_digest: digest("1"),
  policy_version: "director-policy-2026-07-24",
  expires_at: "2026-07-24T12:10:00.000Z",
};

const reviewPlan: EditReviewPlan = {
  schema_version: "1.0",
  review_plan_id: "review_1",
  source_duration_us: 30_000_000,
  estimated_duration_us: 28_000_000,
  story_outline: ["问题", "演示", "结果"],
  suggestions: [
    {
      suggestion_id: "suggestion_pause_1",
      category: "pause",
      source_asset_ref: "asset_primary",
      source_start_us: 1_000_000,
      source_end_us: 1_400_000,
      segment_refs: ["segment_1"],
      token_refs: ["token_zh"],
      excerpt: "停顿 0.4 秒",
      reason: "删除过长停顿",
      risk: "low",
      confidence_millis: 980,
      default_decision: "accept",
    },
  ],
};

const reviewDecisions: EditReviewDecisionSet = {
  schema_version: "1.0",
  decision_set_id: "decisions_1",
  generation_id: "generation_1",
  review_plan_id: reviewPlan.review_plan_id,
  review_plan_digest: digestJcs(reviewPlan),
  project_id: "project_1",
  base_revision: 7,
  decisions: [
    {
      suggestion_id: "suggestion_pause_1",
      decision: "accept",
    },
  ],
  confirmed_at: "2026-07-24T12:05:00.000Z",
};

const manifest: EditDecisionManifest = {
  schema_version: "1.0",
  manifest_id: "manifest_1",
  review_plan_digest: digest("2"),
  final_decisions_digest: digest("3"),
  billing_receipt_ref: "billing_1",
  required_operation_types: ["remove_range"],
  operations: [
    {
      schema_version: "1.0",
      operation_id: "operation_1",
      operation_type: "remove_range",
      base_revision: 7,
      preconditions: [{ kind: "revision_equals", revision: 7 }],
      parameters: {
        source_asset_ref: "asset_primary",
        source_start_us: 1_000_000,
        source_end_us: 1_400_000,
      },
      inverse: { kind: "restore_snapshot", revision: 7 },
      reason: "删除已确认停顿",
    },
  ],
  finishing: {
    caption_style_id: "caption_clean",
    lut_id: "lut_none",
    voice_mode: "original",
    background_music: { mode: "none" },
  },
  summary: "删除一处低风险停顿。",
};

function baseEnvelope<T>(
  artifactType: DirectorEnvelope<T>["artifact_type"],
  payload: T,
): DirectorEnvelope<T> {
  return {
    envelope_version: "1.0",
    artifact_type: artifactType,
    artifact_id: `artifact_${artifactType}`,
    session_id: "session_1",
    account_ref: "account_ref_1",
    project_id: "project_1",
    sequence: 1,
    protocol_version: "1.0",
    policy_version: "director-policy-2026-07-24",
    base_revision: 7,
    planning_input_digest: digest("1"),
    transcript_digest: digest("4"),
    timeline_digest: digest("5"),
    edit_brief_digest: digest("6"),
    answer_chain_digest: digest("7"),
    capabilities_digest: digest("8"),
    issued_at: "2026-07-24T12:00:00.000Z",
    expires_at: "2026-07-24T12:10:00.000Z",
    payload,
    signature: {
      algorithm: "Ed25519",
      key_id: "director_current_1",
      value: "AA==",
    },
  };
}

function publicPem(key: KeyObject): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}

describe("CreatorCut public protocol v1", () => {
  it("implements strict RFC 8785-compatible canonical JSON", () => {
    const left = { b: 2, a: 1 };
    const right = { a: 1, b: 2 };
    expect(canonicalizeJcs(left)).toBe('{"a":1,"b":2}');
    expect(canonicalizeJcs(right)).toBe('{"a":1,"b":2}');
    expect(digestJcs(left)).toBe(
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
    expect(() => canonicalizeJcs({ invalid: Number.NaN })).toThrow(
      "non-finite",
    );
    expect(() => canonicalizeJcs({ invalid: undefined })).toThrow("non-JSON");
    expect(() => canonicalizeJcs(["\ud800"])).toThrow("unpaired");
    const sparse = new Array(1);
    expect(() => canonicalizeJcs(sparse)).toThrow("sparse");
  });

  it("freezes artifact-specific envelope identity fields", () => {
    const cardEnvelope = baseEnvelope("decision_card_set", cards);
    expect(
      validatePublicProtocol("director-envelope", cardEnvelope).valid,
    ).toBe(true);

    const invalidCardEnvelope = {
      ...cardEnvelope,
      generation_id: "generation_forbidden",
    };
    expect(
      validatePublicProtocol("director-envelope", invalidCardEnvelope).valid,
    ).toBe(false);

    const quoteEnvelope = {
      ...baseEnvelope("cost_quote", quote),
      quote_id: quote.quote_id,
    };
    expect(
      validatePublicProtocol("director-envelope", quoteEnvelope).valid,
    ).toBe(true);
    expect(
      validatePublicProtocol("director-envelope", {
        ...quoteEnvelope,
        generation_id: "generation_forbidden",
      }).valid,
    ).toBe(false);

    const reviewEnvelope = {
      ...baseEnvelope("review_plan", reviewPlan),
      quote_id: quote.quote_id,
      generation_id: "generation_1",
    };
    expect(
      validatePublicProtocol("director-envelope", reviewEnvelope).valid,
    ).toBe(true);
  });

  it("validates the minimum path-free planning context and answer contracts", () => {
    expect(validatePublicProtocol("director-context", context).valid).toBe(
      true,
    );
    expect(
      validatePublicProtocol("decision-card-answer-set", answers).valid,
    ).toBe(true);
    expect(
      validatePublicProtocol("edit-review-decision-set", reviewDecisions).valid,
    ).toBe(true);

    const staleDigest = structuredClone(context);
    staleDigest.timeline.tracks[0]!.clips[0]!.timeline_end_us -= 1;
    expect(
      validatePublicProtocol("director-context", staleDigest).issues.map(
        (entry) => entry.code,
      ),
    ).toEqual(
      expect.arrayContaining([
        "semantic.digest_mismatch",
        "semantic.invalid_timeline_mapping",
      ]),
    );

    const invalidAnswer = structuredClone(answers);
    invalidAnswer.answers[0]!.approved = true;
    expect(
      validatePublicProtocol(
        "decision-card-answer-set",
        invalidAnswer,
      ).issues.map((entry) => entry.code),
    ).toContain("semantic.answer_value_count");
  });

  it("validates declarative manifests and rejects executable or path fields", () => {
    expect(
      validatePublicProtocol("edit-decision-manifest", manifest).valid,
    ).toBe(true);

    const withScript = structuredClone(manifest);
    withScript.operations[0]!.parameters = {
      script: "rm -rf /",
    };
    expect(
      validatePublicProtocol("edit-decision-manifest", withScript).issues.map(
        (entry) => entry.code,
      ),
    ).toContain("semantic.executable_field_forbidden");

    const withPath = structuredClone(manifest);
    withPath.operations[0]!.parameters = {
      file: "/Users/example/private.mov",
    };
    expect(
      validatePublicProtocol("edit-decision-manifest", withPath).issues.map(
        (entry) => entry.code,
      ),
    ).toContain("semantic.path_forbidden");
  });

  it("enforces the versioned card and manifest limits", () => {
    expect(CREATORCUT_LIMITS_V1.limits_version).toBe("creatorcut-limits/1.0");
    expect(() => assertCardSetLimits(cards)).not.toThrow();
    expect(() =>
      assertCardSetLimits({
        cards: Array.from(
          { length: CREATORCUT_LIMITS_V1.cards_per_set + 1 },
          () => ({}),
        ),
      }),
    ).toThrow(ProtocolLimitError);
  });

  it("verifies a recovery-root-signed keyset and Director envelope", () => {
    const recovery = generateKeyPairSync("ed25519");
    const director = generateKeyPairSync("ed25519");
    const keysetUnsigned: SignedArtifactKeyset = {
      keyset_version: 1,
      purpose: "director",
      issued_at: "2026-07-24T11:00:00.000Z",
      expires_at: "2026-08-24T11:00:00.000Z",
      keys: [
        {
          key_id: "director_current_1",
          status: "current",
          public_key_pem: publicPem(director.publicKey),
          not_before: "2026-07-24T11:00:00.000Z",
          not_after: "2026-08-24T11:00:00.000Z",
        },
      ],
      signature: {
        algorithm: "Ed25519",
        key_id: "recovery_root_1",
        value: "AA==",
      },
    };
    const keyset: SignedArtifactKeyset = {
      ...keysetUnsigned,
      signature: {
        ...keysetUnsigned.signature,
        value: sign(
          null,
          keysetSigningBytes(keysetUnsigned),
          recovery.privateKey,
        ).toString("base64"),
      },
    };
    const verifiedKeyset = verifySignedKeyset(
      keyset,
      new Map([["recovery_root_1", publicPem(recovery.publicKey)]]),
      {
        purpose: "director",
        minimumVersion: 1,
        now: new Date("2026-07-24T12:00:00.000Z"),
      },
    );

    const unsignedEnvelope: DirectorEnvelope<EditDecisionManifest> = {
      ...baseEnvelope("edit_manifest", manifest),
      quote_id: quote.quote_id,
      generation_id: "generation_1",
      signature: {
        algorithm: "Ed25519",
        key_id: "director_current_1",
        value: "AA==",
      },
    };
    delete unsignedEnvelope.expires_at;
    const envelope: DirectorEnvelope<EditDecisionManifest> = {
      ...unsignedEnvelope,
      signature: {
        ...unsignedEnvelope.signature,
        value: sign(
          null,
          envelopeSigningBytes(unsignedEnvelope),
          director.privateKey,
        ).toString("base64"),
      },
    };

    expect(
      verifyDirectorEnvelope(envelope, verifiedKeyset, {
        now: new Date("2027-07-24T12:00:00.000Z"),
      }).payload.manifest_id,
    ).toBe("manifest_1");

    const tampered = structuredClone(envelope);
    tampered.payload.summary = "被篡改";
    expect(() => verifyDirectorEnvelope(tampered, verifiedKeyset)).toThrow(
      "signature",
    );
  });

  it("rejects keyset rollback and revoked Director keys", () => {
    const recovery = generateKeyPairSync("ed25519");
    const currentDirector = generateKeyPairSync("ed25519");
    const revokedDirector = generateKeyPairSync("ed25519");
    const unsigned: SignedArtifactKeyset = {
      keyset_version: 2,
      purpose: "director",
      issued_at: "2026-07-24T11:00:00.000Z",
      expires_at: "2026-08-24T11:00:00.000Z",
      keys: [
        {
          key_id: "director_current_2",
          status: "current",
          public_key_pem: publicPem(currentDirector.publicKey),
          not_before: "2026-07-24T11:00:00.000Z",
          not_after: "2026-08-24T11:00:00.000Z",
        },
        {
          key_id: "director_revoked_1",
          status: "revoked",
          public_key_pem: publicPem(revokedDirector.publicKey),
          not_before: "2026-07-24T11:00:00.000Z",
          not_after: "2026-08-24T11:00:00.000Z",
        },
      ],
      signature: {
        algorithm: "Ed25519",
        key_id: "recovery_root_1",
        value: "AA==",
      },
    };
    const signed: SignedArtifactKeyset = {
      ...unsigned,
      signature: {
        ...unsigned.signature,
        value: sign(
          null,
          keysetSigningBytes(unsigned),
          recovery.privateKey,
        ).toString("base64"),
      },
    };
    expect(() =>
      verifySignedKeyset(
        signed,
        new Map([["recovery_root_1", publicPem(recovery.publicKey)]]),
        {
          purpose: "director",
          minimumVersion: 3,
          now: new Date("2026-07-24T12:00:00.000Z"),
        },
      ),
    ).toThrow("rollback");

    const verified = verifySignedKeyset(
      signed,
      new Map([["recovery_root_1", publicPem(recovery.publicKey)]]),
      {
        purpose: "director",
        now: new Date("2026-07-24T12:00:00.000Z"),
      },
    );
    const revokedUnsigned: DirectorEnvelope<SemanticDecisionCardSet> = {
      ...baseEnvelope("decision_card_set", cards),
      signature: {
        algorithm: "Ed25519",
        key_id: "director_revoked_1",
        value: "AA==",
      },
    };
    const revokedEnvelope: DirectorEnvelope<SemanticDecisionCardSet> = {
      ...revokedUnsigned,
      signature: {
        ...revokedUnsigned.signature,
        value: sign(
          null,
          envelopeSigningBytes(revokedUnsigned),
          revokedDirector.privateKey,
        ).toString("base64"),
      },
    };
    expect(() =>
      verifyDirectorEnvelope(revokedEnvelope, verified, {
        now: new Date("2026-07-24T12:00:00.000Z"),
      }),
    ).toThrow("revoked");
  });
});
