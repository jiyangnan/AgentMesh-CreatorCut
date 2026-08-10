import { randomUUID } from "node:crypto";

import {
  normalizeHostSubmission,
  presentationIdForProject,
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
  compareAndSwapLocalArtifact,
  openCreatorCutProject,
  readLocalArtifact,
  readDirectorState,
  requireDirectorConsent,
  writeDirectorState,
  type OpenedCreatorCutProject,
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
        ...(request.idempotencyKey
          ? { "idempotency-key": request.idempotencyKey }
          : {}),
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

const REMOTE_EFFECT_PATH = "tasks/director-remote-effect.json";

interface DirectorRemoteEffect {
  schema_version: "creatorcut-director-remote-effect/1.0";
  effect_id: string;
  effect_kind: string;
  project_id: string;
  base_revision: number;
  planning_input_digest: string;
  request_digest: string;
  status: "pending" | "remote_committed" | "completed";
  remote_response_digest?: string;
  remote_session_id?: string;
  remote_generation_id?: string;
  created_at: string;
  updated_at: string;
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
  readonly #finalizePollIntervalMs: number;
  readonly #finalizePollAttempts: number;
  readonly #sleep: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;

  constructor(options: CloudDirectorAdapterOptions) {
    this.#endpoint = normalizedEndpoint(options.endpoint);
    this.#apiKey = assertApiKey(options.apiKey);
    this.#protocolBundleDigest = options.protocolBundleDigest;
    this.#hostType = options.hostType ?? "text";
    this.#now = options.now ?? (() => new Date());
    this.#uuid = options.uuid ?? randomUUID;
    this.#finalizePollIntervalMs = Math.max(
      0,
      options.finalizePollIntervalMs ?? 500,
    );
    this.#finalizePollAttempts = Math.max(
      1,
      options.finalizePollAttempts ?? 60,
    );
    this.#sleep =
      options.sleep ??
      ((milliseconds, signal) =>
        new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          const timer = setTimeout(resolve, milliseconds);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        }));
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

  async #remoteEffectRequest<T>(input: {
    opened: OpenedCreatorCutProject;
    context: DirectorContext;
    effectKind: string;
    request: DirectorTransportRequest;
    recover?: (error: unknown) => Promise<T>;
  }): Promise<{
    value: T;
    effect: DirectorRemoteEffect;
    opened: OpenedCreatorCutProject;
  }> {
    const requestDigest = digestJcs({
      method: input.request.method,
      path: input.request.path,
      body: input.request.body ?? null,
    });
    const existing = await readLocalArtifact<DirectorRemoteEffect>(
      input.opened.directory,
      REMOTE_EFFECT_PATH,
    );
    let effect: DirectorRemoteEffect;
    let opened = input.opened;
    if (existing && existing.status !== "completed") {
      if (
        existing.schema_version !== "creatorcut-director-remote-effect/1.0" ||
        existing.effect_kind !== input.effectKind ||
        existing.project_id !== input.context.project_id ||
        existing.base_revision !== input.context.base_revision ||
        existing.planning_input_digest !== digestJcs(input.context) ||
        existing.request_digest !== requestDigest
      ) {
        throw new Error(
          "Another CreatorCut Director remote effect requires recovery",
        );
      }
      effect = existing;
    } else {
      const timestamp = this.#now().toISOString();
      effect = {
        schema_version: "creatorcut-director-remote-effect/1.0",
        effect_id: `director-effect:${this.#uuid()}`,
        effect_kind: input.effectKind,
        project_id: input.context.project_id,
        base_revision: input.context.base_revision,
        planning_input_digest: digestJcs(input.context),
        request_digest: requestDigest,
        status: "pending",
        created_at: timestamp,
        updated_at: timestamp,
      };
      const begun = await compareAndSwapLocalArtifact<
        DirectorRemoteEffect,
        undefined
      >(
        opened.directory,
        REMOTE_EFFECT_PATH,
        {
          projectId: opened.project.project_id,
          revision: opened.project.revision,
          authorityGeneration: opened.authorityGeneration,
          artifactDigest: digestJcs(existing),
          mutationKind: "director_remote_effect",
        },
        async () => ({ nextArtifact: effect, value: undefined }),
      );
      opened = await openCreatorCutProject(opened.directory);
      if (opened.authorityGeneration !== begun.authorityGeneration) {
        throw new Error("Director remote effect authority changed");
      }
    }

    const value = await this.#request<T>({
      ...input.request,
      idempotencyKey: effect.effect_id,
    }).catch((error: unknown) =>
      input.recover ? input.recover(error) : Promise.reject(error),
    );
    const responseRecord =
      value !== null && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    const committed: DirectorRemoteEffect = {
      ...effect,
      status: "remote_committed",
      remote_response_digest: digestJcs(value),
      ...(typeof responseRecord.session_id === "string"
        ? { remote_session_id: responseRecord.session_id }
        : {}),
      ...(typeof responseRecord.generation_id === "string"
        ? { remote_generation_id: responseRecord.generation_id }
        : {}),
      updated_at: this.#now().toISOString(),
    };
    const current = await openCreatorCutProject(opened.directory);
    await compareAndSwapLocalArtifact<DirectorRemoteEffect, undefined>(
      current.directory,
      REMOTE_EFFECT_PATH,
      {
        projectId: current.project.project_id,
        revision: current.project.revision,
        authorityGeneration: current.authorityGeneration,
        artifactDigest: digestJcs(effect),
        mutationKind: "director_remote_effect",
      },
      async () => ({ nextArtifact: committed, value: undefined }),
    );
    return {
      value,
      effect: committed,
      opened: await openCreatorCutProject(current.directory),
    };
  }

  async #completeRemoteEffect(
    projectDirectory: string,
    effect: DirectorRemoteEffect,
  ): Promise<void> {
    const opened = await openCreatorCutProject(projectDirectory);
    const current = await readLocalArtifact<DirectorRemoteEffect>(
      projectDirectory,
      REMOTE_EFFECT_PATH,
    );
    if (!current || current.effect_id !== effect.effect_id) {
      throw new Error("CreatorCut Director remote effect identity changed");
    }
    if (current.status === "completed") return;
    await compareAndSwapLocalArtifact<DirectorRemoteEffect, undefined>(
      projectDirectory,
      REMOTE_EFFECT_PATH,
      {
        projectId: opened.project.project_id,
        revision: opened.project.revision,
        authorityGeneration: opened.authorityGeneration,
        artifactDigest: digestJcs(current),
        mutationKind: "director_remote_effect",
      },
      async () => ({
        nextArtifact: {
          ...current,
          status: "completed",
          updated_at: this.#now().toISOString(),
        },
        value: undefined,
      }),
    );
  }

  async start(input: {
    projectDirectory: string;
    signal?: AbortSignal;
  }): Promise<PublicDirectorState> {
    let opened = await openCreatorCutProject(input.projectDirectory);
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
    let remoteEffect: DirectorRemoteEffect | undefined;
    const session = state.session_id
      ? await this.#request<DirectorSessionView>({
          method: "GET",
          path: `/v1/director/sessions/${encodeURIComponent(state.session_id)}`,
          authenticated: true,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        })
      : await this.#remoteEffectRequest<DirectorSessionView>({
          opened,
          context,
          effectKind: "session_start",
          request: {
            method: "POST",
            path: "/v1/director/sessions",
            authenticated: true,
            body: context,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          },
        }).then((result) => {
          opened = result.opened;
          remoteEffect = result.effect;
          return result.value;
        });
    this.#assertSession(session, context, state.session_id);
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
    if (remoteEffect) {
      await this.#completeRemoteEffect(input.projectDirectory, remoteEffect);
    }
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
      {
        presentationId: presentationIdForProject(
          state.current_card_envelope.project_id,
        ),
      },
    );
    return { envelope: state.current_card_envelope, presentation };
  }

  async submitCards(input: {
    projectDirectory: string;
    submission: HostCardSubmission;
    presentation?: HostCardPresentation;
  }): Promise<PublicDirectorState> {
    let opened = await openCreatorCutProject(input.projectDirectory);
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
        {
          presentationId: presentationIdForProject(
            state.current_card_envelope.project_id,
          ),
        },
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
    const remote = await this.#remoteEffectRequest<DirectorSessionView>({
      opened,
      context,
      effectKind: "cards_submit",
      request: {
        method: "POST",
        path: `/v1/director/sessions/${encodeURIComponent(state.session_id)}/answers`,
        authenticated: true,
        body: answerSet,
      },
    });
    opened = remote.opened;
    const session = remote.value;
    this.#assertSession(session, context, state.session_id);
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
    await this.#completeRemoteEffect(input.projectDirectory, remote.effect);
    return next;
  }

  async quote(projectDirectory: string): Promise<DirectorEnvelope<CostQuote>> {
    let opened = await openCreatorCutProject(projectDirectory);
    const context = buildDirectorContext(opened, { hostType: this.#hostType });
    await requireDirectorConsent(opened, context);
    const state = await this.#requireState(opened, context);
    if (!state.session_id || state.current_card_envelope) {
      throw new Error("CreatorCut Director cards must finish before quote");
    }
    const remote = await this.#remoteEffectRequest<{
      quote_envelope: DirectorEnvelope<CostQuote>;
    }>({
      opened,
      context,
      effectKind: "quote_create",
      request: {
        method: "POST",
        path: `/v1/director/sessions/${encodeURIComponent(state.session_id)}/quote`,
        authenticated: true,
      },
    });
    opened = remote.opened;
    const result = remote.value;
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
    await this.#completeRemoteEffect(projectDirectory, remote.effect);
    return quote;
  }

  async generate(input: {
    projectDirectory: string;
    confirmationId: string;
  }): Promise<DirectorGenerationView> {
    if (!input.confirmationId.trim()) {
      throw new TypeError("CreatorCut quote confirmation ID is required");
    }
    let opened = await openCreatorCutProject(input.projectDirectory);
    const context = buildDirectorContext(opened, { hostType: this.#hostType });
    await requireDirectorConsent(opened, context);
    const state = await this.#requireState(opened, context);
    if (!state.session_id || !state.quote_envelope) {
      throw new Error("CreatorCut Director quote is missing");
    }
    const generationId = state.generation_id ?? this.#uuid();
    if (state.generation_id === undefined) {
      await writeDirectorState(opened, {
        ...state,
        generation_id: generationId,
        updated_at: this.#now().toISOString(),
      });
      opened = await openCreatorCutProject(input.projectDirectory);
    }
    const remote = await this.#remoteEffectRequest<DirectorGenerationView>({
      opened,
      context,
      effectKind: "generation_create",
      request: {
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
      },
      recover: async (error) => {
        try {
          return await this.#request<DirectorGenerationView>({
            method: "GET",
            path: `/v1/director/generations/${encodeURIComponent(generationId)}`,
            authenticated: true,
          });
        } catch {
          throw error;
        }
      },
    });
    opened = remote.opened;
    const generation = remote.value;
    this.#assertGeneration(generation, context, {
      generationId,
      sessionId: state.session_id,
      quoteId: state.quote_envelope.payload.quote_id,
    });
    await writeDirectorState(opened, {
      ...state,
      generation_id: generationId,
      generation_state: generation.state,
      updated_at: this.#now().toISOString(),
    });
    await this.#completeRemoteEffect(input.projectDirectory, remote.effect);
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
      this.#assertGeneration(generation, context, {
        generationId: state.generation_id,
        ...(state.session_id === undefined
          ? {}
          : { sessionId: state.session_id }),
        ...(state.quote_envelope === undefined
          ? {}
          : { quoteId: state.quote_envelope.payload.quote_id }),
      });
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
    this.#assertSession(session, context, state.session_id);
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
    this.#assertGeneration(generation, context, {
      generationId: state.generation_id,
      ...(state.session_id === undefined
        ? {}
        : { sessionId: state.session_id }),
      quoteId: state.quote_envelope.payload.quote_id,
    });
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
    let opened = await openCreatorCutProject(projectDirectory);
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
    const decisionEffect =
      await this.#remoteEffectRequest<DirectorGenerationView>({
        opened,
        context,
        effectKind: "review_decisions_submit",
        request: {
          method: "POST",
          path: `/v1/director/generations/${encodeURIComponent(state.generation_id)}/review-decisions`,
          authenticated: true,
          body: decisions,
        },
      });
    await this.#completeRemoteEffect(projectDirectory, decisionEffect.effect);
    opened = await openCreatorCutProject(projectDirectory);
    const finalizeEffect =
      await this.#remoteEffectRequest<DirectorGenerationView>({
        opened,
        context,
        effectKind: "generation_finalize",
        request: {
          method: "POST",
          path: `/v1/director/generations/${encodeURIComponent(state.generation_id)}/finalize`,
          authenticated: true,
        },
      });
    opened = finalizeEffect.opened;
    let generation = finalizeEffect.value;
    for (
      let attempt = 0;
      !generation.manifest_envelope && attempt < this.#finalizePollAttempts;
      attempt += 1
    ) {
      this.#assertGeneration(generation, context, {
        generationId: state.generation_id,
        ...(state.session_id === undefined
          ? {}
          : { sessionId: state.session_id }),
        quoteId: state.quote_envelope.payload.quote_id,
      });
      if (
        ["failed", "failed_terminal", "refunded"].includes(generation.state)
      ) {
        throw new Error(
          `CreatorCut Director finalization failed: ${generation.error_code ?? generation.state}`,
        );
      }
      if (generation.state === "ready") {
        throw new Error(
          "CreatorCut Director returned ready without a signed Manifest",
        );
      }
      await this.#sleep(this.#finalizePollIntervalMs);
      generation = await this.#request<DirectorGenerationView>({
        method: "GET",
        path: `/v1/director/generations/${encodeURIComponent(state.generation_id)}`,
        authenticated: true,
      });
    }
    if (!generation.manifest_envelope) {
      throw new Error(
        "CreatorCut Director finalization is still processing; retry finalize",
      );
    }
    this.#assertGeneration(generation, context, {
      generationId: state.generation_id,
      ...(state.session_id === undefined
        ? {}
        : { sessionId: state.session_id }),
      quoteId: state.quote_envelope.payload.quote_id,
    });
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
    await this.#completeRemoteEffect(projectDirectory, finalizeEffect.effect);
    return manifest;
  }

  async getVerifiedManifest(
    projectDirectory: string,
  ): Promise<DirectorEnvelope<EditDecisionManifest>> {
    const opened = await openCreatorCutProject(projectDirectory);
    const context = buildDirectorContext(opened, { hostType: this.#hostType });
    const state = await this.#requireState(opened, context);
    if (
      !state.manifest_envelope ||
      !state.review_envelope ||
      !state.quote_envelope ||
      !state.generation_id
    ) {
      throw new Error("CreatorCut signed Manifest is missing");
    }
    return this.#verifyEnvelope<EditDecisionManifest>({
      value: state.manifest_envelope,
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
  }

  async deleteSession(projectDirectory: string): Promise<void> {
    let opened = await openCreatorCutProject(projectDirectory);
    const context = buildDirectorContext(opened, { hostType: this.#hostType });
    const state = await readDirectorState<PublicDirectorState>(opened);
    let remoteEffect: DirectorRemoteEffect | undefined;
    if (state?.session_id) {
      const remote = await this.#remoteEffectRequest<unknown>({
        opened,
        context,
        effectKind: "session_delete",
        request: {
          method: "DELETE",
          path: `/v1/director/sessions/${encodeURIComponent(state.session_id)}`,
          authenticated: true,
        },
      });
      opened = remote.opened;
      remoteEffect = remote.effect;
    }
    await clearDirectorState(opened);
    if (remoteEffect) {
      await this.#completeRemoteEffect(projectDirectory, remoteEffect);
    }
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

  #assertSession(
    session: DirectorSessionView,
    context: DirectorContext,
    expectedSessionId?: string,
  ): void {
    if (
      (expectedSessionId !== undefined &&
        session.session_id !== expectedSessionId) ||
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
    expected: {
      generationId?: string;
      sessionId?: string;
      quoteId?: string;
    } = {},
  ): void {
    if (
      (expected.generationId !== undefined &&
        generation.generation_id !== expected.generationId) ||
      (expected.sessionId !== undefined &&
        generation.session_id !== expected.sessionId) ||
      (expected.quoteId !== undefined &&
        generation.quote_id !== expected.quoteId) ||
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
