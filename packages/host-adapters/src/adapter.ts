import {
  digestJcs,
  type PublicClientCapabilities,
  type SemanticDecisionCardSet,
} from "@agentmesh/creatorcut-protocol";
import { buildPublicClientCapabilities } from "@agentmesh/creatorcut-client-capabilities";

import type {
  CanonicalCardPresentation,
  HostCardPresentation,
  HostCardSubmission,
  NormalizedAnswers,
  PresentSemanticCardsOptions,
  PresentedCard,
  PresentedOption,
} from "./types.js";

const controls = {
  single: "radio",
  multi: "checkbox",
  text: "textarea",
  visual: "visual-picker",
  voice: "voice-picker",
  review: "approval",
} as const;

export function capabilitiesForHost(
  hostType: PublicClientCapabilities["host_type"],
  clientVersion = "0.1.0",
): PublicClientCapabilities {
  return buildPublicClientCapabilities(hostType, clientVersion);
}

function canRenderNative(
  card: SemanticDecisionCardSet["cards"][number],
  capabilities: PublicClientCapabilities,
): boolean {
  if (capabilities.host_type === "text") return false;
  if (!capabilities.card_types.includes(card.type)) return false;
  if (card.type === "visual" && !capabilities.supports_visual_previews) {
    return false;
  }
  if (card.type === "voice" && !capabilities.supports_voice_preview) {
    return false;
  }
  return true;
}

function optionLine(option: PresentedOption): string {
  const description = option.description ? ` — ${option.description}` : "";
  const preview = option.preview_ref ? ` (preview: ${option.preview_ref})` : "";
  return `${option.submission_value}. ${option.label}${description}${preview}`;
}

function cardFallback(card: Omit<PresentedCard, "fallback_text">): string {
  const lines = [
    `[${card.card_id}] ${card.title}${card.required ? " *" : ""}`,
    card.prompt,
  ];
  if (card.known_value_source) {
    lines.push(`Known from: ${card.known_value_source}`);
  }
  if (card.options) lines.push(...card.options.map(optionLine));
  if (card.default_option_ids?.length) {
    const defaults = card.options
      ?.filter((option) => card.default_option_ids?.includes(option.option_id))
      .map((option) => option.submission_value);
    lines.push(`Prefill: ${(defaults ?? []).join(",")}`);
  } else if (card.default_text !== undefined) {
    lines.push(`Prefill: ${card.default_text}`);
  } else if (card.default_approved !== undefined) {
    lines.push(`Prefill: ${card.default_approved ? "approve" : "reject"}`);
  }
  if (card.type === "text") {
    lines.push("Reply with the text value.");
  } else if (card.type === "review") {
    lines.push("Reply with approve or reject.");
  } else {
    lines.push("Reply with the shown number token(s).");
  }
  return lines.join("\n");
}

export function presentationIdForProject(projectId: string): string {
  const value = projectId.startsWith("project-")
    ? projectId.slice("project-".length)
    : projectId;
  if (!value) {
    throw new TypeError("CreatorCut project ID cannot produce a presentation");
  }
  return `presentation-${value}`;
}

export function answerSetIdForPresentation(presentationDigest: string): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(presentationDigest);
  if (!match) {
    throw new TypeError("CreatorCut presentation digest is invalid");
  }
  return `answers:${match[1]!.slice(0, 32)}`;
}

export function buildCanonicalPresentation(
  cardSet: SemanticDecisionCardSet,
  presentationId: string,
): CanonicalCardPresentation {
  const unsigned = {
    schema_version: "creatorcut-canonical-presentation/1.0" as const,
    presentation_id: presentationId,
    card_set_id: cardSet.card_set_id,
    state_revision: cardSet.state_revision,
    stage: cardSet.stage,
    cards: cardSet.cards.map((card) => ({
      card_id: card.card_id,
      type: card.type,
      option_ids: card.options?.map((option) => option.option_id) ?? [],
    })),
  };
  return { ...unsigned, presentation_digest: digestJcs(unsigned) };
}

export function presentSemanticCards(
  cardSet: SemanticDecisionCardSet,
  capabilities: PublicClientCapabilities,
  options: PresentSemanticCardsOptions = {},
): HostCardPresentation {
  const canonical = buildCanonicalPresentation(
    cardSet,
    options.presentationId ??
      `presentation-${cardSet.card_set_id}-${cardSet.state_revision}`,
  );
  const cards: PresentedCard[] = cardSet.cards.map((card) => {
    const options = card.options?.map((option, index) => ({
      option_id: option.option_id,
      submission_value: String(index + 1),
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      ...(option.preview_ref ? { preview_ref: option.preview_ref } : {}),
    }));
    const base: Omit<PresentedCard, "fallback_text"> = {
      card_id: card.card_id,
      type: card.type,
      title: card.title,
      prompt: card.prompt,
      required: card.required,
      render_mode: canRenderNative(card, capabilities)
        ? "native"
        : "text-fallback",
      control: controls[card.type],
      ...(options ? { options } : {}),
      ...(card.default_option_ids
        ? { default_option_ids: card.default_option_ids }
        : {}),
      ...(card.default_text === undefined
        ? {}
        : { default_text: card.default_text }),
      ...(card.default_approved === undefined
        ? {}
        : { default_approved: card.default_approved }),
      ...(card.min_selections === undefined
        ? {}
        : { min_selections: card.min_selections }),
      ...(card.max_selections === undefined
        ? {}
        : { max_selections: card.max_selections }),
      ...(card.placeholder ? { placeholder: card.placeholder } : {}),
      ...(card.known_value_source
        ? { known_value_source: card.known_value_source }
        : {}),
    };
    return { ...base, fallback_text: cardFallback(base) };
  });
  const render = {
    schema_version: "creatorcut-host-presentation/1.0" as const,
    presentation_id: canonical.presentation_id,
    presentation_digest: canonical.presentation_digest,
    host_type: capabilities.host_type,
    card_set_id: cardSet.card_set_id,
    state_revision: cardSet.state_revision,
    stage: cardSet.stage,
    cards,
    text_fallback: cards.map((card) => card.fallback_text).join("\n\n"),
  };
  return {
    ...render,
    render_digest: digestJcs(render),
  };
}

export function normalizeHostSubmission(
  cardSet: SemanticDecisionCardSet,
  presentation: HostCardPresentation,
  submission: HostCardSubmission,
): NormalizedAnswers {
  if (
    submission.presentation_id !== presentation.presentation_id ||
    submission.presentation_digest !== presentation.presentation_digest ||
    presentation.card_set_id !== cardSet.card_set_id ||
    presentation.state_revision !== cardSet.state_revision
  ) {
    throw new TypeError("CreatorCut card presentation binding mismatch");
  }
  const byCard = new Map(
    submission.responses.map((response) => [response.card_id, response]),
  );
  if (byCard.size !== submission.responses.length) {
    throw new TypeError("CreatorCut card submission contains duplicate cards");
  }
  return cardSet.cards.map((card) => {
    const response = byCard.get(card.card_id);
    if (!response) {
      if (card.required) {
        throw new TypeError(
          `Missing required CreatorCut card: ${card.card_id}`,
        );
      }
      return { card_id: card.card_id };
    }
    if (card.type === "text") {
      if (response.text_value === undefined) {
        throw new TypeError(`Card ${card.card_id} requires a text value`);
      }
      return { card_id: card.card_id, text_value: response.text_value };
    }
    if (card.type === "review") {
      if (response.approved === undefined) {
        throw new TypeError(`Card ${card.card_id} requires approve or reject`);
      }
      return { card_id: card.card_id, approved: response.approved };
    }
    const optionBySubmissionValue = new Map(
      presentation.cards
        .find((candidate) => candidate.card_id === card.card_id)
        ?.options?.map((option) => [
          option.submission_value,
          option.option_id,
        ]) ?? [],
    );
    const optionIds = new Set(card.options?.map((option) => option.option_id));
    const selected = (response.selected_values ?? []).map(
      (value) => optionBySubmissionValue.get(value) ?? value,
    );
    if (selected.some((optionId) => !optionIds.has(optionId))) {
      throw new TypeError(`Card ${card.card_id} contains an unknown option`);
    }
    if (card.required && selected.length < (card.min_selections ?? 1)) {
      throw new TypeError(`Card ${card.card_id} has too few selections`);
    }
    if (
      card.max_selections !== undefined &&
      selected.length > card.max_selections
    ) {
      throw new TypeError(`Card ${card.card_id} has too many selections`);
    }
    return { card_id: card.card_id, selected_option_ids: selected };
  });
}
