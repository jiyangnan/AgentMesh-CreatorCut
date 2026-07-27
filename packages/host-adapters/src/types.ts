import type {
  DecisionCardAnswerSet,
  PublicClientCapabilities,
  SemanticDecisionCardSet,
} from "@agentmesh/creatorcut-protocol";

export interface PresentedOption {
  option_id: string;
  submission_value: string;
  label: string;
  description?: string;
  preview_ref?: string;
}

export interface PresentedCard {
  card_id: string;
  type: SemanticDecisionCardSet["cards"][number]["type"];
  title: string;
  prompt: string;
  required: boolean;
  render_mode: "native" | "text-fallback";
  control:
    | "radio"
    | "checkbox"
    | "textarea"
    | "visual-picker"
    | "voice-picker"
    | "approval";
  options?: PresentedOption[];
  default_option_ids?: string[];
  default_text?: string;
  default_approved?: boolean;
  min_selections?: number;
  max_selections?: number;
  placeholder?: string;
  known_value_source?: string;
  fallback_text: string;
}

export interface HostCardPresentation {
  schema_version: "creatorcut-host-presentation/1.0";
  presentation_id: string;
  presentation_digest: string;
  host_type: PublicClientCapabilities["host_type"];
  card_set_id: string;
  state_revision: number;
  stage: SemanticDecisionCardSet["stage"];
  cards: PresentedCard[];
  text_fallback: string;
}

export interface HostCardResponse {
  card_id: string;
  selected_values?: string[];
  text_value?: string;
  approved?: boolean;
}

export interface HostCardSubmission {
  answer_set_id: string;
  presentation_id: string;
  presentation_digest: string;
  responses: HostCardResponse[];
}

export type NormalizedAnswers = DecisionCardAnswerSet["answers"];
