import { describe, expect, it } from "vitest";

import {
  type PublicClientCapabilities,
  type SemanticDecisionCardSet,
} from "@agentmesh/creatorcut-protocol";
import { buildPublicClientCapabilities } from "@agentmesh/creatorcut-client-capabilities";

import {
  answerSetIdForPresentation,
  capabilitiesForHost,
  normalizeHostSubmission,
  presentSemanticCards,
} from "../src/index.js";

const cards: SemanticDecisionCardSet = {
  schema_version: "1.0",
  card_set_id: "cards-1",
  state_revision: 3,
  stage: "direction",
  cards: [
    {
      card_id: "pace",
      type: "single",
      title: "Pace",
      prompt: "Choose a pace",
      required: true,
      options: [
        { option_id: "natural", label: "Natural" },
        { option_id: "tight", label: "Tight" },
      ],
      default_option_ids: ["natural"],
    },
    {
      card_id: "terms",
      type: "text",
      title: "Terms",
      prompt: "Add protected terms",
      required: false,
      default_text: "CreatorCut",
    },
  ],
};

function capabilities(
  host_type: PublicClientCapabilities["host_type"],
): PublicClientCapabilities {
  return {
    schema_version: "1.0",
    client_version: "0.2.0",
    host_type,
    protocol_versions: ["1.0"],
    card_types: ["single", "multi", "text", "visual", "voice", "review"],
    operation_types: ["remove_range"],
    supports_visual_previews: host_type === "codex",
    supports_voice_preview: host_type === "codex",
    max_payload_bytes: 1_048_576,
  };
}

describe("cross-host card adapters", () => {
  it("derives one stable answer id from the canonical presentation digest", () => {
    expect(answerSetIdForPresentation(`sha256:${"a".repeat(64)}`)).toBe(
      `answers:${"a".repeat(32)}`,
    );
    expect(() => answerSetIdForPresentation("sha256:stale")).toThrow(
      /presentation digest is invalid/u,
    );
  });

  it("uses the single public capabilities builder for every host", () => {
    for (const hostType of [
      "codex",
      "claude_code",
      "openclaw",
      "text",
    ] as const) {
      expect(capabilitiesForHost(hostType, "0.1.7")).toEqual(
        buildPublicClientCapabilities(hostType, "0.1.7"),
      );
    }
  });

  it("keeps stable semantic answers across native and text hosts", () => {
    const codex = presentSemanticCards(cards, capabilities("codex"));
    const text = presentSemanticCards(cards, capabilities("text"));
    const nativeAnswers = normalizeHostSubmission(cards, codex, {
      answer_set_id: "answer-1",
      presentation_id: codex.presentation_id,
      presentation_digest: codex.presentation_digest,
      responses: [
        { card_id: "pace", selected_values: ["tight"] },
        { card_id: "terms", text_value: "CreatorCut" },
      ],
    });
    const textAnswers = normalizeHostSubmission(cards, text, {
      answer_set_id: "answer-2",
      presentation_id: text.presentation_id,
      presentation_digest: text.presentation_digest,
      responses: [
        { card_id: "pace", selected_values: ["2"] },
        { card_id: "terms", text_value: "CreatorCut" },
      ],
    });
    expect(
      text.cards.every((card) => card.render_mode === "text-fallback"),
    ).toBe(true);
    expect(codex.presentation_id).toBe(text.presentation_id);
    expect(codex.presentation_digest).toBe(text.presentation_digest);
    expect(codex.render_digest).not.toBe(text.render_digest);
    expect(textAnswers).toEqual(nativeAnswers);
  });

  it("rejects stale presentations and unknown options", () => {
    const presentation = presentSemanticCards(cards, capabilities("text"));
    expect(() =>
      normalizeHostSubmission(cards, presentation, {
        answer_set_id: "answer-1",
        presentation_id: presentation.presentation_id,
        presentation_digest: "sha256:stale",
        responses: [{ card_id: "pace", selected_values: ["2"] }],
      }),
    ).toThrow(/binding mismatch/u);
    expect(() =>
      normalizeHostSubmission(cards, presentation, {
        answer_set_id: "answer-1",
        presentation_id: presentation.presentation_id,
        presentation_digest: presentation.presentation_digest,
        responses: [{ card_id: "pace", selected_values: ["99"] }],
      }),
    ).toThrow(/unknown option/u);
  });
});
