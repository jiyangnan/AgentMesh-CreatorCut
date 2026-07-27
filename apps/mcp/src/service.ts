import type { CloudDirectorAdapter } from "@agentmesh/creatorcut-director-client";
import {
  capabilitiesForHost,
  type HostCardSubmission,
} from "@agentmesh/creatorcut-host-adapters";
import type { PublicClientCapabilities } from "@agentmesh/creatorcut-protocol";
import {
  approveDirectorContext,
  buildDirectorContext,
  inspectDirectorContext,
  openCreatorCutProject,
  readDirectorConsent,
} from "@agentmesh/creatorcut-runtime";

export class CreatorCutMcpService {
  constructor(
    readonly projectDirectory: string,
    readonly getAdapter: () => Promise<CloudDirectorAdapter>,
    readonly hostType: PublicClientCapabilities["host_type"] = "text",
  ) {}

  async projectStatus(): Promise<Record<string, unknown>> {
    const opened = await openCreatorCutProject(this.projectDirectory);
    const consent = await readDirectorConsent(opened);
    return {
      project_id: opened.project.project_id,
      name: opened.project.name,
      revision: opened.project.revision,
      language_mode: opened.transcript.language_mode,
      transcript_segments: opened.transcript.segments.length,
      director_consent: consent !== null,
    };
  }

  async inspectContext(): Promise<Record<string, unknown>> {
    const opened = await openCreatorCutProject(this.projectDirectory);
    return {
      inspection: inspectDirectorContext(
        buildDirectorContext(opened, { hostType: this.hostType }),
      ),
    };
  }

  async approveContext(): Promise<Record<string, unknown>> {
    const opened = await openCreatorCutProject(this.projectDirectory);
    const context = buildDirectorContext(opened, {
      hostType: this.hostType,
    });
    return {
      consent: await approveDirectorContext(opened, context),
    };
  }

  async startDirector(): Promise<Record<string, unknown>> {
    const state = await (
      await this.getAdapter()
    ).start({ projectDirectory: this.projectDirectory });
    return { state };
  }

  async getCards(): Promise<Record<string, unknown>> {
    const capabilities = capabilitiesForHost(this.hostType);
    const cards = await (
      await this.getAdapter()
    ).getCards({
      projectDirectory: this.projectDirectory,
      capabilities,
    });
    return {
      envelope_id: cards.envelope.artifact_id,
      envelope_digest: cards.presentation.presentation_digest,
      presentation: cards.presentation,
    };
  }

  async submitCards(input: {
    submission: HostCardSubmission;
  }): Promise<Record<string, unknown>> {
    const adapter = await this.getAdapter();
    const current = await adapter.getCards({
      projectDirectory: this.projectDirectory,
      capabilities: capabilitiesForHost(this.hostType),
    });
    const state = await adapter.submitCards({
      projectDirectory: this.projectDirectory,
      submission: input.submission,
      presentation: current.presentation,
    });
    return { state };
  }

  async quote(): Promise<Record<string, unknown>> {
    return {
      quote_envelope: await (
        await this.getAdapter()
      ).quote(this.projectDirectory),
    };
  }

  async status(): Promise<Record<string, unknown>> {
    return {
      status: await (await this.getAdapter()).status(this.projectDirectory),
    };
  }

  async review(): Promise<Record<string, unknown>> {
    return {
      review_envelope: await (
        await this.getAdapter()
      ).review(this.projectDirectory),
    };
  }
}
