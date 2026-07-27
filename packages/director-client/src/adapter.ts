import { randomUUID } from "node:crypto";

import {
  normalizeHostSubmission,
  presentSemanticCards,
  type HostCardPresentation,
  type HostCardSubmission,
} from "@agentmesh/creatorcut-host-adapters";
import {
  assertPublicProtocol,
  digestJcs,
  verifyDirectorEnvelope,
  verifySignedKeyset,
  type CostQuote,
  type DecisionCardAnswerSet,
  type DirectorContext,
  type DirectorEnvelope,
  type EditDecisionManifest,
  type EditReviewDecisionSet,
  type EditReviewPlan,
  type SemanticDecisionCardSet,
  type SignedArtifactKeyset,
} from "@agentmesh/creatorcut-protocol";
import {
  buildDirectorContext,
  clearDirectorState,
  openCreatorCutProject,
  readDirectorState,
  requireDirectorConsent,
  writeDirectorState,
} from "@agentmesh/creatorcut-runtime";

import type {
  CloudDirectorAdapterOptions,
  DirectorGenerationView,
  DirectorPreflight,
  DirectorSessionView,
  DirectorTransport,
  DirectorTransportRequest,
  FinalizeDirectorInput,
  PresentedDirectorCards,
  PublicDirectorState,
} from "./types.js";

function normalizedEndpoint(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new TypeError(
      "CreatorCut Director requires HTTPS except for loopback development",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function assertApiKey(value: string): string {
  const apiKey = value.trim();
  if (!apiKey || /\s/u.test(apiKey)) {
    throw new TypeError(
      "CreatorCut Director API key must be non-empty and contain no whitespace",
    );
  }
  return apiKey;
}

function httpTransport(endpoint: string, apiKey: string): DirectorTransport {
  return async (request) => {
    const response = await fetch(`${endpoint}${request.path}`, {
      method: request.method,
      headers: {
        accept: "application/json",
        ...(request.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(request.authenticated ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      ...(request.body === undefined
        ? {}
        : { body: JSON.stringify(request.body) }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const record =
        payload && typeof payload === "object"
          ? (payload as Record<string, unknown>)
          : {};
      const error =
        record.error && typeof record.error === "object"
          ? (record.error as Record<string, unknown>)
          : {};
      const code =
        typeof error.code === "string" ? error.code : "request_failed";
      throw new Error(`CreatorCut Director ${response.status}: ${code}`);
    }
    return payload;
  };
}

function emptyState(context: DirectorContext, now: Date): PublicDirectorState {
  return {
    schema_version: "creatorcut-public-director-state/1.0",
    project_id: context.project_id,
    base_revision: context.base_revision,
    planning_input_digest: digestJcs(context),
    updated_at: now.toISOString(),
  };
}

export class CloudDirectorAdapter {
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #protocolBundleDigest: string;
  readonly #hostType: DirectorContext["capabilities"]["host_type"];
  readonly #keyset: SignedArtifactKeyset;
  readonly #transport: DirectorTransport;
  readonly #now: () => Date;
  readonly #uuid: () => string;

  constructor(options: CloudDirectorAdapterOptions) {
    this.#endpoint = normalizedEndpoint(options.endpoint);
    this.#apiKey = assertApiKey(options.apiKey);
    this.#protocolBundleDigest = options.protocolBundleDigest;
    this.#hostType = options.hostType ?? "text";
    this.#now = options.now ?? (() => new Date());
    this.#uuid = options.uuid ?? randomUUID;
    this.#keyset = verifySignedKeyset(
      options.signedKeyset,
      options.trustedRecoveryRoots,
      {
        purpose: "director",
        ...(options.minimumKeysetVersion === undefined
          ? {}
          : { minimumVersion: options.minimumKeysetVersion }),
        now: this.#now(),
      },
    );
    this.#transport =
      options.transport ?? httpTransport(this.#endpoint, this.#apiKey);
  }

  async preflight(signal?: AbortSignal): Promise<DirectorPreflight> {
    const value = await this.#request<DirectorPreflight>({
      method: "POST",
      path: "/v1/director/preflight",
      authenticated: false,
      body: {
        product_id: "creatorcut",
        protocol_bundle_digest: this.#protocolBundleDigest,
        host_id: "creatorcut_public_client",
      },
      ...(signal === undefined ? {} : { signal }),
    });
    if (
      !value.compatible ||
      value.protocol_bundle_digest !== this.#protocolBundleDigest ||
      value.action_code !== "creatorcut.director.plan" ||
      value.cost <= 0
    ) {
      throw new Error("CreatorCut Director preflight is incompatible");
    }
    return value;
  }

  async start(input: {
    projectDirectory: string;
    signal?: AbortSignal;
  }): Promise<PublicDirectorState> {
    const opened = await openCreatorCutProject(input.projectDirectory);
    const context = buildDirectorContext(opened, {
      hostType: this.#hostType,
    });
    await requireDirectorConsent(opened, context);
    const preflight = await this.preflight(input.signal);
    if (!preflight.core_enabled || !preflight.accepting_new_generations) {
      throw new Error("CreatorCut Director is not accepting new work");
    }
    let state =
      (await readDirectorState<PublicDirectorState>(opened)) ??
      emptyState(context, this.#now());
    if (
      state.project_id !== context.project_id ||
      state.base_revision !== context.base_revision ||
      state.planning_input_digest !== digestJcs(context)
    ) {
      state = emptyState(context, this.#now());
    }
    const session = state.session_id
      ? await this.#request<DirectorSessionView>({
          method: "GET",
          path: `/v1/director/sessions/${encodeURIComponent(state.session_id)}`,
          authenticated: true,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        })
      : await this.#request<DirectorSessionView>({
          method: "POST",
          path: "/v1/director/sessions",
          authenticated: true,
          body: context,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
    this.#assertSession(session, context);
    const currentCard = session.current_card_envelope
      ? this.#verifyEnvelope<SemanticDecisionCardSet>({
          value: session.current_card_envelope,
          context,
          artifactType: "decision_card_set",
          expectedPreviousDigest: state.last_envelope_digest ?? null,
          expectedSequence:
            state.last_sequence === undefined ? 1 : state.last_sequence + 1,
          expectedSessionId: session.session_id,
          ...(state.account_ref === undefined
            ? {}
            : { expectedAccountRef: state.account_ref }),
        })
      : undefined;
    state = {
      ...state,
      session_id: session.session_id,
      session_stage: session.stage,
      state_revision: session.state_revision,
      ...(currentCard ? { current_card_envelope: currentCard } : {}),
      updated_at: this.#now().toISOString(),
    };
    await writeDirectorState(opened, state);
    return state;
  }

  async getCards(input: {
    projectDirectory: string;
    capabilities?: DirectorContext["capabilities"];
  }): Promise<PresentedDirectorCards> {
    const opened = await openCreatorCutProject(input.projectDirectory);
    const context = buildDirectorContext(opened, { hostType: this.#hostType });
    await requireDirectorConsent(opened, context);
    const state = await this.#requireState(opened, context);
    if (!state.current_card_envelope) {
      throw new Error("CreatorCut Director has no pending cards");
    }
    const presentation = presentSemanticCards(
      state.current_card_envelope.payload,
      input.capabilities ?? context.capabilities,
    );
    return { envelope: state.current_card_envelope, presentation };
  }

  async submitCards(input: {
    projectDirectory: string;
    submission: HostCardSubmission;
    presentation?: HostCardPresentation;
  }): Promise<PublicDirectorState> {
    const opened = await openCreatorCutProject(input.projectDirectory);
    const context = buildDirectorContext(opened, { hostType: this.#hostType });
    await requireDirectorConsent(opened, context);
    const state = await this.#requireState(opened, context);
    if (!state.session_id || !state.current_card_envelope) {
      throw new Error("CreatorCut Director has no pending card submission");
    }
    const presentation =
      input.presentation ??
      presentSemanticCards(
        state.current_card_envelope.payload,
        context.capabilities,
      );
    const answers = normalizeHostSubmission(
      state.current_card_envelope.payload,
      presentation,
      input.submission,
    );
    const envelopeDigest = digestJcs(state.current_card_envelope);
    const answerSet = assertPublicProtocol<DecisionCardAnswerSet>(
      "decision-card-answer-set",
      {
        schema_version: "1.0",
        answer_set_id: input.submission.answer_set_id,
        card_set_id: state.current_card_envelope.payload.card_set_id,
        card_set_digest: digestJcs(state.current_card_envelope.payload),
        presentation_digest: presentation.presentation_digest,
        capabilities_digest: context.capabilities_digest,
        planning_input_digest: digestJcs(context),
        previous_envelope_digest: envelopeDigest,
        project_id: context.project_id,
        base_revision: context.base_revision,
        state_revision: state.current_card_envelope.payload.state_revision,
        answers,
      },
    );
    const session = await this.#request<DirectorSessionView>({
      method: "POST",
      path: `/v1/director/sessions/${encodeURIComponent(state.session_id)}/answers`,
      authenticated: true,
      body: answerSet,
    });
    this.#assertSession(session, context);
    const nextCard = session.current_card_envelope
      ? this.#verifyEnvelope<SemanticDecisionCardSet>({
          value: session.current_card_envelope,
          context,
          artifactType: "decision_card_set",
          expectedPreviousDigest: envelopeDigest,
          expectedSequence: state.current_card_envelope.sequence + 1,
          expectedSessionId: state.session_id,
          expectedAccountRef:
            state.account_ref ?? state.current_card_envelope.account_ref,
        })
      : undefined;
    const { current_card_envelope: _currentCard, ...stateWithoutCard } = state;
    const next: PublicDirectorState = {
      ...stateWithoutCard,
      account_ref: state.account_ref ?? state.current_card_envelope.account_ref,
      session_stage: session.stage,
      state_revision: session.state_revision,
      last_envelope_digest: envelopeDigest,
      last_sequence: state.current_card_envelope.sequence,
      ...(nextCard ? { current_card_envelope: nextCard } : {}),
      updated_at: this.#now().toISOString(),
    };
    await writeDirectorState(opened, next);
    return next;
  }

  async quote(projectDirectory: string): Promise<DirectorEnvelope<CostQuote>> {
    const opened = await openCreatorCutProject(projectDirectory);
    const context = buildDirectorContext(opened, { hostType: this.#hostType });
    await requireDirectorConsent(opened, context);
    const state = await this.#requireState(opened, context);
    if (!state.session_id || state.current_card_envelope) {
      throw new Error("CreatorCut Director cards must finish before quote");
    }
    const result = await this.#request<{
      quote_envelope: DirectorEnvelope<CostQuote>;
    }>({
      method: "POST",
      path: `/v1/director/sessions/${encodeURIComponent(state.session_id)}/quote`,
      authenticated: true,
    });
    const quote = this.#verifyEnvelope<CostQuote>({
      value: result.quote_envelope,
      context,
      artifactType: "cost_quote",
      ...(state.last_envelope_digest === undefined
        ? {}
        : { expectedPreviousDigest: state.last_envelope_digest }),
      ...(state.last_sequence === undefined
        ? {}
        : { expectedSequence: state.last_sequence + 1 }),
      expectedSessionId: state.session_id,
      ...(state.account_ref === undefined
        ? {}
        : { expectedAccountRef: state.account_ref }),
    });
    if (
      quote.payload.action_code !== "creatorcut.director.plan" ||
      quote.payload.cost <= 0 ||
      quote.payload.planning_input_digest !== digestJcs(context)
    ) {
      throw new TypeError("CreatorCut Director returned an invalid quote");
    }
    await writeDirectorState(opened, {
      ...state,
      account_ref: state.account_ref ?? quote.account_ref,
      quote_envelope: quote,
      last_envelope_digest: digestJcs(quote),
      last_sequence: quote.sequence,
      updated_at: this.#now().toISOString(),
    });
    return quote;
  }

  async generate(input: {
    projectDirectory: string;
    confirmationId: string;
  }): Promise<DirectorGenerationView> {
    if (!input.confirmationId.trim()) {
      throw new TypeError("CreatorCut quote confirmation ID is required");
    }
    const opened = await openCreatorCutProject(input.projectDirectory);
    const context = buildDirectorContext(opened, { hostType: this.#hostType });
    await requireDirectorConsent(opened, context);
    const state = await this.#requireState(opened, context);
    if (!state.session_id || !state.quote_envelope) {
      throw new Error("CreatorCut Director quote is missing");
    }
    const generationId = state.generation_id ?? this.#uuid();
    const generation = await this.#request<DirectorGenerationView>({
      method: "POST",
      path: `/v1/director/sessions/${encodeURIComponent(state.session_id)}/generations`,
      authenticated: true,
      body: {
        generation_id: generationId,
        quote_id: state.quote_envelope.payload.quote_id,
        quote_envelope_digest: digestJcs(state.quote_envelope),
        explicit_confirmation_id: input.confirmationId,
        planning_input_digest: digestJcs(context),
      },
    }).catch(async (error: unknown) => {
      try {
        return await this.#request<DirectorGenerationView>({
          method: "GET",
          path: `/v1/director/generations/${encodeURIComponent(generationId)}`,
          authenticated: true,
        });
      } catch {
        throw error;
      }
    });
    this.#assertGeneration(generation, context);
    await writeDirectorState(opened, {
      ...state,
      generation_id: generationId,
      generation_state: generation.state,
      updated_at: this.#now().toISOString(),
    });
    return generation;
  }

  async status(
    projectDirectory: string,
  ): Promise<
    | { kind: "generation"; value: DirectorGenerationView }
    | { kind: "session"; value: DirectorSessionView }
  > {
    const opened = await openCreatorCutProject(projectDirectory);
    const context = buildDirectorContext(opened, { hostType: this.#hostType });
    const state = await this.#requireState(opened, context);
    if (state.generation_id) {
      const generation = await this.#request<DirectorGenerationView>({
        method: "GET",
        path: `/v1/director/generations/${encodeURIComponent(state.generation_id)}`,
        authenticated: true,
      });
      this.#assertGeneration(generation, context);
      await writeDirectorState(opened, {
        ...state,
        generation_state: generation.state,
        updated_at: this.#now().toISOString(),
      });
      return { kind: "generation", value: generation };
    }
    if (!state.session_id)
      throw new Error("CreatorCut Director session missing");
    const session = await this.#request<DirectorSessionView>({
      method: "GET",
      path: `/v1/director/sessions/${encodeURIComponent(state.session_id)}`,
      authenticated: true,
    });
    this.#assertSession(session, context);
    return { kind: "session", value: session };
  }

  async review(
    projectDirectory: string,
  ): Promise<DirectorEnvelope<EditReviewPlan>> {
    const opened = await openCreatorCutProject(projectDirectory);
    const context = buildDirectorContext(opened, { hostType: this.#hostType });
    const state = await this.#requireState(opened, context);
    if (!state.generation_id || !state.quote_envelope) {
      throw new Error("CreatorCut Director Generation is missing");
    }
    const generation = await this.#request<DirectorGenerationView>({
      method: "GET",
      path: `/v1/director/generations/${encodeURIComponent(state.generation_id)}`,
      authenticated: true,
    });
    this.#assertGeneration(generation, context);
    const review = this.#verifyEnvelope<EditReviewPlan>({
      value: generation.review_envelope,
      context,
      artifactType: "review_plan",
      expectedPreviousDigest: digestJcs(state.quote_envelope),
      expectedSequence: state.quote_envelope.sequence + 1,
      ...(state.session_id === undefined
        ? {}
        : { expectedSessionId: state.session_id }),
      expectedGenerationId: state.generation_id,
      expectedQuoteId: state.quote_envelope.payload.quote_id,
      ...(state.account_ref === undefined
        ? {}
        : { expectedAccountRef: state.account_ref }),
    });
    await writeDirectorState(opened, {
      ...state,
      generation_state: generation.state,
      review_envelope: review,
      updated_at: this.#now().toISOString(),
    });
    return review;
  }

  async finalize(
    projectDirectory: string,
    input: FinalizeDirectorInput,
  ): Promise<DirectorEnvelope<EditDecisionManifest>> {
    const opened = await openCreatorCutProject(projectDirectory);
    const context = buildDirectorContext(opened, { hostType: this.#hostType });
    const state = await this.#requireState(opened, context);
    if (
      !state.generation_id ||
      !state.review_envelope ||
      !state.quote_envelope
    ) {
      throw new Error("CreatorCut signed ReviewPlan is missing");
    }
    const decisions = assertPublicProtocol<EditReviewDecisionSet>(
      "edit-review-decision-set",
      input.decisions,
    );
    if (
      decisions.generation_id !== state.generation_id ||
      decisions.review_plan_id !==
        state.review_envelope.payload.review_plan_id ||
      decisions.review_plan_digest !==
        digestJcs(state.review_envelope.payload) ||
      decisions.project_id !== context.project_id ||
      decisions.base_revision !== context.base_revision
    ) {
      throw new TypeError("CreatorCut review decisions binding mismatch");
    }
    await this.#request<DirectorGenerationView>({
      method: "POST",
      path: `/v1/director/generations/${encodeURIComponent(state.generation_id)}/review-decisions`,
      authenticated: true,
      body: decisions,
    });
    let generation = await this.#request<DirectorGenerationView>({
      method: "POST",
      path: `/v1/director/generations/${encodeURIComponent(state.generation_id)}/finalize`,
      authenticated: true,
    });
    if (!generation.manifest_envelope) {
      generation = await this.#request<DirectorGenerationView>({
        method: "GET",
        path: `/v1/director/generations/${encodeURIComponent(state.generation_id)}`,
        authenticated: true,
      });
    }
    this.#assertGeneration(generation, context);
    const manifest = this.#verifyEnvelope<EditDecisionManifest>({
      value: generation.manifest_envelope,
      context,
      artifactType: "edit_manifest",
      expectedPreviousDigest: digestJcs(state.review_envelope),
      expectedSequence: state.review_envelope.sequence + 1,
      ...(state.session_id === undefined
        ? {}
        : { expectedSessionId: state.session_id }),
      expectedGenerationId: state.generation_id,
      expectedQuoteId: state.quote_envelope.payload.quote_id,
      ...(state.account_ref === undefined
        ? {}
        : { expectedAccountRef: state.account_ref }),
    });
    await writeDirectorState(opened, {
      ...state,
      generation_state: generation.state,
      manifest_envelope: manifest,
      updated_at: this.#now().toISOString(),
    });
    return manifest;
  }

  async deleteSession(projectDirectory: string): Promise<void> {
    const opened = await openCreatorCutProject(projectDirectory);
    const state = await readDirectorState<PublicDirectorState>(opened);
    if (state?.session_id) {
      await this.#request({
        method: "DELETE",
        path: `/v1/director/sessions/${encodeURIComponent(state.session_id)}`,
        authenticated: true,
      });
    }
    await clearDirectorState(opened);
  }

  async #requireState(
    opened: Awaited<ReturnType<typeof openCreatorCutProject>>,
    context: DirectorContext,
  ): Promise<PublicDirectorState> {
    const state = await readDirectorState<PublicDirectorState>(opened);
    if (
      !state ||
      state.schema_version !== "creatorcut-public-director-state/1.0" ||
      state.project_id !== context.project_id ||
      state.base_revision !== context.base_revision ||
      state.planning_input_digest !== digestJcs(context)
    ) {
      throw new Error(
        "CreatorCut Director state is missing or stale; start the current revision",
      );
    }
    return state;
  }

  #verifyEnvelope<T>(input: {
    value: unknown;
    context: DirectorContext;
    artifactType: DirectorEnvelope["artifact_type"];
    expectedPreviousDigest?: string | null;
    expectedSequence?: number;
    expectedSessionId?: string;
    expectedGenerationId?: string;
    expectedQuoteId?: string;
    expectedAccountRef?: string;
  }): DirectorEnvelope<T> {
    if (this.#now().getTime() > Date.parse(this.#keyset.expires_at)) {
      throw new TypeError("CreatorCut Director keyset expired during use");
    }
    const envelope = verifyDirectorEnvelope<T>(input.value, this.#keyset, {
      now: this.#now(),
    });
    const contextDigest = digestJcs(input.context);
    const mismatches = [
      envelope.artifact_type !== input.artifactType,
      envelope.project_id !== input.context.project_id,
      envelope.base_revision !== input.context.base_revision,
      envelope.planning_input_digest !== contextDigest,
      envelope.transcript_digest !== input.context.transcript_digest,
      envelope.timeline_digest !== input.context.timeline_digest,
      envelope.edit_brief_digest !== input.context.edit_brief_digest,
      envelope.capabilities_digest !== input.context.capabilities_digest,
      input.expectedSequence !== undefined &&
        envelope.sequence !== input.expectedSequence,
      input.expectedPreviousDigest === null
        ? envelope.previous_envelope_digest !== undefined
        : input.expectedPreviousDigest !== undefined &&
          envelope.previous_envelope_digest !== input.expectedPreviousDigest,
      input.expectedSessionId !== undefined &&
        envelope.session_id !== input.expectedSessionId,
      input.expectedGenerationId !== undefined &&
        envelope.generation_id !== input.expectedGenerationId,
      input.expectedQuoteId !== undefined &&
        envelope.quote_id !== input.expectedQuoteId,
      input.expectedAccountRef !== undefined &&
        envelope.account_ref !== input.expectedAccountRef,
    ];
    if (mismatches.some(Boolean)) {
      throw new TypeError(
        `CreatorCut Director ${input.artifactType} envelope binding mismatch`,
      );
    }
    return envelope;
  }

  #assertSession(session: DirectorSessionView, context: DirectorContext): void {
    if (
      session.project_id !== context.project_id ||
      session.base_revision !== context.base_revision ||
      session.planning_input_digest !== digestJcs(context) ||
      session.state !== "active"
    ) {
      throw new TypeError("CreatorCut Director session binding mismatch");
    }
  }

  #assertGeneration(
    generation: DirectorGenerationView,
    context: DirectorContext,
  ): void {
    if (
      generation.project_id !== context.project_id ||
      generation.base_revision !== context.base_revision ||
      generation.planning_input_digest !== digestJcs(context)
    ) {
      throw new TypeError("CreatorCut Director Generation binding mismatch");
    }
  }

  async #request<T = unknown>(request: DirectorTransportRequest): Promise<T> {
    return (await this.#transport(request)) as T;
  }
}
