import type {
  CostQuote,
  DirectorEnvelope,
  EditDecisionManifest,
  EditReviewDecisionSet,
  EditReviewPlan,
  SemanticDecisionCardSet,
  SignedArtifactKeyset,
} from "@agentmesh/creatorcut-protocol";
import type {
  HostCardPresentation,
  HostCardSubmission,
} from "@agentmesh/creatorcut-host-adapters";

export interface DirectorTransportRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  authenticated: boolean;
  body?: unknown;
  signal?: AbortSignal;
}

export type DirectorTransport = (
  request: DirectorTransportRequest,
) => Promise<unknown>;

export interface CloudDirectorAdapterOptions {
  endpoint: string;
  apiKey: string;
  protocolBundleDigest: string;
  signedKeyset: SignedArtifactKeyset;
  trustedRecoveryRoots: ReadonlyMap<string, string>;
  minimumKeysetVersion?: number;
  hostType?: import("@agentmesh/creatorcut-protocol").PublicClientCapabilities["host_type"];
  transport?: DirectorTransport;
  now?: () => Date;
  uuid?: () => string;
  finalizePollIntervalMs?: number;
  finalizePollAttempts?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface DirectorSessionView {
  session_id: string;
  project_id: string;
  base_revision: number;
  planning_input_digest: string;
  state: string;
  stage: string;
  state_revision: number;
  answer_chain_digest: string;
  current_card_envelope?: DirectorEnvelope<SemanticDecisionCardSet>;
}

export interface DirectorGenerationView {
  generation_id: string;
  session_id: string;
  project_id: string;
  base_revision: number;
  planning_input_digest: string;
  quote_id: string;
  state: string;
  attempt: number;
  review_envelope?: DirectorEnvelope<EditReviewPlan>;
  manifest_envelope?: DirectorEnvelope<EditDecisionManifest>;
  error_code?: string;
}

export interface DirectorPreflight {
  product_id: "creatorcut";
  protocol_version: "1.0";
  protocol_bundle_digest: string;
  compatible: boolean;
  action_code: "creatorcut.director.plan";
  cost: number;
  core_enabled: boolean;
  accepting_new_generations: boolean;
}

export interface PublicDirectorState {
  schema_version: "creatorcut-public-director-state/1.0";
  project_id: string;
  base_revision: number;
  planning_input_digest: string;
  session_id?: string;
  account_ref?: string;
  session_stage?: string;
  state_revision?: number;
  last_envelope_digest?: string;
  last_sequence?: number;
  current_card_envelope?: DirectorEnvelope<SemanticDecisionCardSet>;
  quote_envelope?: DirectorEnvelope<CostQuote>;
  generation_id?: string;
  generation_state?: string;
  review_envelope?: DirectorEnvelope<EditReviewPlan>;
  manifest_envelope?: DirectorEnvelope<EditDecisionManifest>;
  updated_at: string;
}

export interface PresentedDirectorCards {
  envelope: DirectorEnvelope<SemanticDecisionCardSet>;
  presentation: HostCardPresentation;
}

export interface FinalizeDirectorInput {
  decisions: EditReviewDecisionSet;
}

export type {
  CostQuote,
  EditDecisionManifest,
  EditReviewPlan,
  HostCardSubmission,
};
