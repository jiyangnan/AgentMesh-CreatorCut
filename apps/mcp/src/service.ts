import type { CloudDirectorAdapter } from "@agentmesh/creatorcut-director-client";
import {
  answerSetIdForPresentation,
  capabilitiesForHost,
  type HostCardPresentation,
  type HostCardSubmission,
} from "@agentmesh/creatorcut-host-adapters";
import {
  applyPreviewedManifest,
  cancelExportTask,
  previewSignedManifest,
  readExportTask,
  resumeExportTask,
  startExportTask,
} from "@agentmesh/creatorcut-media-engine";
import {
  digestJcs,
  type PublicClientCapabilities,
} from "@agentmesh/creatorcut-protocol";
import {
  approveDirectorContext,
  buildDirectorContext,
  inspectDirectorContext,
  openCreatorCutProject,
  readDirectorConsent,
  redoLocalRevision,
  undoLocalRevision,
} from "@agentmesh/creatorcut-runtime";
import {
  cancelTranscriptionTask,
  readTranscriptionTask,
  resumeTranscriptionTask,
  transcribeProject,
  type LanguageMode,
} from "@agentmesh/creatorcut-transcription";

export interface McpCardPayload {
  envelope_id: string;
  envelope_digest: string;
  presentation_digest: string;
  render_digest: string;
  presentation: HostCardPresentation;
}

export interface McpCardWidgetPayload extends McpCardPayload {
  answer_set_id: string;
}

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
        buildDirectorContext(opened, { hostType: "text" }),
      ),
    };
  }

  async approveContext(): Promise<Record<string, unknown>> {
    const opened = await openCreatorCutProject(this.projectDirectory);
    const context = buildDirectorContext(opened, {
      hostType: "text",
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

  async getCards(): Promise<McpCardPayload> {
    const capabilities = capabilitiesForHost(this.hostType);
    const cards = await (
      await this.getAdapter()
    ).getCards({
      projectDirectory: this.projectDirectory,
      capabilities,
    });
    return {
      envelope_id: cards.envelope.artifact_id,
      envelope_digest: digestJcs(cards.envelope),
      presentation_digest: cards.presentation.presentation_digest,
      render_digest: cards.presentation.render_digest,
      presentation: cards.presentation,
    };
  }

  async renderCards(expected: {
    envelopeDigest?: string;
    presentationDigest?: string;
    renderDigest?: string;
  }): Promise<McpCardWidgetPayload> {
    const current = await this.getCards();
    if (
      expected.envelopeDigest !== undefined &&
      expected.envelopeDigest !== current.envelope_digest
    ) {
      throw new TypeError(
        "CreatorCut card envelope changed; read the current cards again",
      );
    }
    if (
      expected.presentationDigest !== undefined &&
      expected.presentationDigest !== current.presentation_digest
    ) {
      throw new TypeError(
        "CreatorCut card presentation changed; read the current cards again",
      );
    }
    if (
      expected.renderDigest !== undefined &&
      expected.renderDigest !== current.render_digest
    ) {
      throw new TypeError(
        "CreatorCut host rendering changed; read the current cards again",
      );
    }
    return {
      ...current,
      answer_set_id: answerSetIdForPresentation(current.presentation_digest),
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

  async preview(outputPath?: string): Promise<Record<string, unknown>> {
    const adapter = await this.getAdapter();
    const manifest = await adapter.getVerifiedManifest(this.projectDirectory);
    return {
      ...(await previewSignedManifest(
        this.projectDirectory,
        manifest,
        outputPath,
      )),
    };
  }

  async apply(confirmationToken: string): Promise<Record<string, unknown>> {
    const adapter = await this.getAdapter();
    const manifest = await adapter.getVerifiedManifest(this.projectDirectory);
    const result = await applyPreviewedManifest(
      this.projectDirectory,
      manifest,
      confirmationToken,
    );
    return {
      project_id: result.opened.project.project_id,
      revision: result.opened.project.revision,
      manifest_digest: result.manifest_digest,
    };
  }

  async undo(): Promise<Record<string, unknown>> {
    const opened = await undoLocalRevision(this.projectDirectory);
    return {
      project_id: opened.project.project_id,
      revision: opened.project.revision,
    };
  }

  async redo(): Promise<Record<string, unknown>> {
    const opened = await redoLocalRevision(this.projectDirectory);
    return {
      project_id: opened.project.project_id,
      revision: opened.project.revision,
    };
  }

  async exportStart(
    outputPath: string,
    confirmOverwrite: boolean,
  ): Promise<Record<string, unknown>> {
    return {
      task: await startExportTask(this.projectDirectory, outputPath, {
        overwrite: confirmOverwrite,
      }),
    };
  }

  async exportStatus(): Promise<Record<string, unknown>> {
    const task = await readExportTask(this.projectDirectory);
    if (!task) throw new Error("CreatorCut export task is missing");
    return { task };
  }

  async exportResume(): Promise<Record<string, unknown>> {
    return { task: await resumeExportTask(this.projectDirectory) };
  }

  async exportCancel(): Promise<Record<string, unknown>> {
    return { task: await cancelExportTask(this.projectDirectory) };
  }

  async transcriptionStart(input: {
    modelPath: string;
    languageMode: LanguageMode;
    glossary: string[];
  }): Promise<Record<string, unknown>> {
    return {
      task: await transcribeProject({
        projectDirectory: this.projectDirectory,
        modelPath: input.modelPath,
        languageMode: input.languageMode,
        glossary: input.glossary,
      }),
    };
  }

  async transcriptionStatus(): Promise<Record<string, unknown>> {
    const task = await readTranscriptionTask(this.projectDirectory);
    if (!task) throw new Error("CreatorCut transcription task is missing");
    return { task };
  }

  async transcriptionResume(): Promise<Record<string, unknown>> {
    return { task: await resumeTranscriptionTask(this.projectDirectory) };
  }

  async transcriptionCancel(): Promise<Record<string, unknown>> {
    return { task: await cancelTranscriptionTask(this.projectDirectory) };
  }
}
