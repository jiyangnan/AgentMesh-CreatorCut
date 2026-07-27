import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  CREATORCUT_CARD_WIDGET_HTML,
  CREATORCUT_CARD_WIDGET_URI,
  MCP_APP_MIME_TYPE,
} from "./card-widget.js";
import { CreatorCutMcpService } from "./service.js";

const response = (value: object, summary: string) => ({
  content: [{ type: "text" as const, text: summary }],
  structuredContent: { ...value } as Record<string, unknown>,
});
const errorResponse = (error: unknown) => ({
  isError: true as const,
  content: [
    {
      type: "text" as const,
      text: `CreatorCut error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    },
  ],
});

export function createCreatorCutMcpServer(
  service: CreatorCutMcpService,
): McpServer {
  const server = new McpServer(
    { name: "creatorcut-mcp", version: "0.1.0" },
    {
      instructions:
        "CreatorCut is bound to one local project. Start with creatorcut_project_status, then inspect the exact DirectorContext. Only signed Server-driven cards may request user answers. Preserve stable IDs, use the host text fallback when native controls are unavailable, and never invent a local strategy when Director is offline.",
    },
  );

  server.registerResource(
    "creatorcut-decision-cards",
    CREATORCUT_CARD_WIDGET_URI,
    {
      title: "CreatorCut Decision Cards",
      description:
        "Inline, revision-bound CreatorCut decision cards. The widget keeps only temporary form state and submits through the public MCP tool.",
      mimeType: MCP_APP_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: CREATORCUT_CARD_WIDGET_URI,
          mimeType: MCP_APP_MIME_TYPE,
          text: CREATORCUT_CARD_WIDGET_HTML,
          _meta: {
            ui: {
              prefersBorder: true,
              csp: {
                connectDomains: [],
                resourceDomains: [],
              },
            },
          },
        },
      ],
    }),
  );

  server.registerTool(
    "creatorcut_project_status",
    {
      title: "CreatorCut Project Status",
      description:
        "Read current local project revision, transcript language facts, and Director consent state without contacting the cloud.",
      inputSchema: {},
      outputSchema: { project: z.record(z.string(), z.unknown()) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const project = await service.projectStatus();
        return response(
          { project },
          `CreatorCut project ${String(project.project_id)} at revision ${String(project.revision)}.`,
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.registerTool(
    "creatorcut_director_context_inspect",
    {
      title: "Inspect CreatorCut Director Context",
      description:
        "Show the exact revision-bound transcript and structured facts that CreatorCut would upload. No original media, screenshots, absolute paths, or usernames are included.",
      inputSchema: {},
      outputSchema: { inspection: z.record(z.string(), z.unknown()) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const output = await service.inspectContext();
        return response(
          output,
          "CreatorCut DirectorContext is ready for explicit project-level review.",
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.registerTool(
    "creatorcut_director_start",
    {
      title: "Start or Resume CreatorCut Director",
      description:
        "After project-level consent exists, perform the content-free compatibility preflight and start or resume the exact Director session.",
      inputSchema: {},
      outputSchema: { state: z.record(z.string(), z.unknown()) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const output = await service.startDirector();
        return response(output, "CreatorCut Director session is ready.");
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.registerTool(
    "creatorcut_director_context_consent",
    {
      title: "Approve CreatorCut Director Context",
      description:
        "Persist project-level approval for the exact context most recently inspected for this host. Requires an explicit true confirmation and does not contact the Director.",
      inputSchema: { confirm_upload: z.literal(true) },
      outputSchema: { consent: z.record(z.string(), z.unknown()) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ confirm_upload }) => {
      try {
        if (!confirm_upload) {
          throw new Error("Explicit DirectorContext approval is required");
        }
        const output = await service.approveContext();
        return response(
          output,
          "CreatorCut project-level DirectorContext consent recorded.",
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.registerTool(
    "creatorcut_director_cards_get",
    {
      title: "Get CreatorCut Decision Cards",
      description:
        "Get the current signed semantic card set from the private Director. Returns stable card and option IDs plus a semantically equivalent text fallback for every host.",
      inputSchema: {},
      outputSchema: {
        envelope_id: z.string(),
        envelope_digest: z.string(),
        presentation_digest: z.string(),
        render_digest: z.string(),
        presentation: z.record(z.string(), z.unknown()),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const output = await service.getCards();
        return response(
          output,
          String(
            output.presentation.text_fallback ?? "CreatorCut cards ready.",
          ),
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.registerTool(
    "creatorcut_director_cards_render",
    {
      title: "Render CreatorCut Decision Cards",
      description:
        "Render the authoritative current signed card set as an MCP App. Call creatorcut_director_cards_get first when chaining, then pass its digests to reject any intervening state change. Text fallback remains available when UI is unsupported.",
      inputSchema: {
        expected_envelope_digest: z.string().min(1).max(128).optional(),
        expected_presentation_digest: z.string().min(1).max(128).optional(),
        expected_render_digest: z.string().min(1).max(128).optional(),
      },
      outputSchema: {
        answer_set_id: z.string(),
        envelope_id: z.string(),
        envelope_digest: z.string(),
        presentation_digest: z.string(),
        render_digest: z.string(),
        presentation: z.record(z.string(), z.unknown()),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: {
        ui: { resourceUri: CREATORCUT_CARD_WIDGET_URI },
        "openai/outputTemplate": CREATORCUT_CARD_WIDGET_URI,
        "openai/toolInvocation/invoking": "Loading CreatorCut decision cards…",
        "openai/toolInvocation/invoked": "CreatorCut decision cards are ready.",
      },
    },
    async ({
      expected_envelope_digest,
      expected_presentation_digest,
      expected_render_digest,
    }) => {
      try {
        const output = await service.renderCards({
          ...(expected_envelope_digest === undefined
            ? {}
            : { envelopeDigest: expected_envelope_digest }),
          ...(expected_presentation_digest === undefined
            ? {}
            : { presentationDigest: expected_presentation_digest }),
          ...(expected_render_digest === undefined
            ? {}
            : { renderDigest: expected_render_digest }),
        });
        return response(
          output,
          String(
            output.presentation.text_fallback ??
              "CreatorCut decision cards are ready.",
          ),
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  const cardResponse = z
    .object({
      card_id: z.string().min(1),
      selected_values: z.array(z.string().min(1)).optional(),
      text_value: z.string().max(8192).optional(),
      approved: z.boolean().optional(),
    })
    .strict();
  server.registerTool(
    "creatorcut_director_cards_submit",
    {
      title: "Submit CreatorCut Decision Cards",
      description:
        "Normalize and submit one complete answer set for the exact current presentation. Rejects stale presentation digests, duplicate cards, unknown options, and missing required answers.",
      inputSchema: {
        answer_set_id: z.string().min(1).max(256),
        presentation_id: z.string().min(1).max(512),
        presentation_digest: z.string().min(1).max(128),
        responses: z.array(cardResponse).min(1).max(64),
      },
      outputSchema: { state: z.record(z.string(), z.unknown()) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      answer_set_id,
      presentation_id,
      presentation_digest,
      responses,
    }) => {
      try {
        const output = await service.submitCards({
          submission: {
            answer_set_id,
            presentation_id,
            presentation_digest,
            responses: responses.map((card) => ({
              card_id: card.card_id,
              ...(card.selected_values === undefined
                ? {}
                : { selected_values: card.selected_values }),
              ...(card.text_value === undefined
                ? {}
                : { text_value: card.text_value }),
              ...(card.approved === undefined
                ? {}
                : { approved: card.approved }),
            })),
          },
        });
        return response(output, "CreatorCut card answers were accepted.");
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.registerTool(
    "creatorcut_edit_quote",
    {
      title: "Get CreatorCut Cost Quote",
      description:
        "Get and verify the signed Core-priced quote after all Director cards finish. This does not create a paid Generation.",
      inputSchema: {},
      outputSchema: { quote_envelope: z.record(z.string(), z.unknown()) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const output = await service.quote();
        return response(
          output,
          "CreatorCut signed quote ready. Explicit confirmation is required before Generation creation.",
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.registerTool(
    "creatorcut_edit_status",
    {
      title: "Get CreatorCut Director Status",
      description:
        "Resume the current Director session or paid Generation by stable local state. Never creates a second Generation.",
      inputSchema: {},
      outputSchema: { status: z.record(z.string(), z.unknown()) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const output = await service.status();
        return response(output, "CreatorCut Director status restored.");
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.registerTool(
    "creatorcut_edit_review",
    {
      title: "Get CreatorCut Signed Review Plan",
      description:
        "Retrieve and verify the current signed ReviewPlan for human review. This does not apply edits.",
      inputSchema: {},
      outputSchema: { review_envelope: z.record(z.string(), z.unknown()) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const output = await service.review();
        return response(
          output,
          "CreatorCut signed ReviewPlan ready for user decisions.",
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.registerTool(
    "creatorcut_edit_preview",
    {
      title: "Render CreatorCut Signed Manifest Preview",
      description:
        "Re-verify the current signed Manifest, deterministically apply it to an in-memory timeline, and render a local preview. It never changes the project revision.",
      inputSchema: { output_path: z.string().min(1).optional() },
      outputSchema: {
        preview: z.record(z.string(), z.unknown()),
        confirmation: z.record(z.string(), z.unknown()),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ output_path }) => {
      try {
        const output = await service.preview(output_path);
        return response(
          output,
          "Review the local CreatorCut preview. Use its exact confirmation token only after the media matches the user's intent.",
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.registerTool(
    "creatorcut_edit_apply",
    {
      title: "Apply Confirmed CreatorCut Manifest",
      description:
        "Apply the exact signed Manifest represented by an unchanged local preview. Requires the preview confirmation token and creates a new undoable project revision.",
      inputSchema: { confirmation_token: z.string().uuid() },
      outputSchema: {
        project_id: z.string(),
        revision: z.number().int().nonnegative(),
        manifest_digest: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ confirmation_token }) => {
      try {
        return response(
          await service.apply(confirmation_token),
          "CreatorCut committed the confirmed Manifest as a new local revision.",
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  for (const [name, title, action] of [
    ["creatorcut_edit_undo", "Undo CreatorCut Revision", () => service.undo()],
    ["creatorcut_edit_redo", "Redo CreatorCut Revision", () => service.redo()],
  ] as const) {
    server.registerTool(
      name,
      {
        title,
        description:
          "Restore an immutable local timeline snapshot as a new monotonic CreatorCut project revision.",
        inputSchema: {},
        outputSchema: {
          project_id: z.string(),
          revision: z.number().int().nonnegative(),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async () => {
        try {
          return response(
            await action(),
            `${title} completed as a new local revision.`,
          );
        } catch (error) {
          return errorResponse(error);
        }
      },
    );
  }

  server.registerTool(
    "creatorcut_transcribe_start",
    {
      title: "Start Local CreatorCut Transcription",
      description:
        "Run local whisper.cpp for Chinese, English, auto, or mixed-language transcription. No media or model data is uploaded.",
      inputSchema: {
        model_path: z.string().min(1),
        language_mode: z.enum(["zh", "en", "mixed", "auto"]),
        glossary: z.array(z.string().min(1).max(128)).max(128).default([]),
      },
      outputSchema: { task: z.record(z.string(), z.unknown()) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ model_path, language_mode, glossary }) => {
      try {
        return response(
          await service.transcriptionStart({
            modelPath: model_path,
            languageMode: language_mode,
            glossary,
          }),
          "CreatorCut local transcription task finished or saved a resumable failure state.",
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  for (const [name, title, action] of [
    [
      "creatorcut_transcribe_status",
      "Get CreatorCut Transcription Status",
      () => service.transcriptionStatus(),
    ],
    [
      "creatorcut_transcribe_resume",
      "Resume CreatorCut Transcription",
      () => service.transcriptionResume(),
    ],
    [
      "creatorcut_transcribe_cancel",
      "Cancel CreatorCut Transcription",
      () => service.transcriptionCancel(),
    ],
  ] as const) {
    server.registerTool(
      name,
      {
        title,
        description:
          "Read or change the current local transcription task state.",
        inputSchema: {},
        outputSchema: { task: z.record(z.string(), z.unknown()) },
        annotations: {
          readOnlyHint: name.endsWith("_status"),
          destructiveHint: name.endsWith("_cancel"),
          idempotentHint: name.endsWith("_status"),
          openWorldHint: false,
        },
      },
      async () => {
        try {
          return response(await action(), `${title} completed.`);
        } catch (error) {
          return errorResponse(error);
        }
      },
    );
  }

  server.registerTool(
    "creatorcut_export_start",
    {
      title: "Start CreatorCut MP4 Export",
      description:
        "Render the current confirmed local timeline to MP4. Existing files are never overwritten without an explicit true confirmation.",
      inputSchema: {
        output_path: z.string().min(1),
        confirm_overwrite: z.boolean().default(false),
      },
      outputSchema: { task: z.record(z.string(), z.unknown()) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ output_path, confirm_overwrite }) => {
      try {
        return response(
          await service.exportStart(output_path, confirm_overwrite),
          "CreatorCut local export finished or saved a resumable failure state.",
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  for (const [name, title, action] of [
    [
      "creatorcut_export_status",
      "Get CreatorCut Export Status",
      () => service.exportStatus(),
    ],
    [
      "creatorcut_export_resume",
      "Resume CreatorCut Export",
      () => service.exportResume(),
    ],
    [
      "creatorcut_export_cancel",
      "Cancel CreatorCut Export",
      () => service.exportCancel(),
    ],
  ] as const) {
    server.registerTool(
      name,
      {
        title,
        description: "Read or change the current local export task state.",
        inputSchema: {},
        outputSchema: { task: z.record(z.string(), z.unknown()) },
        annotations: {
          readOnlyHint: name.endsWith("_status"),
          destructiveHint: name.endsWith("_cancel"),
          idempotentHint: name.endsWith("_status"),
          openWorldHint: false,
        },
      },
      async () => {
        try {
          return response(await action(), `${title} completed.`);
        } catch (error) {
          return errorResponse(error);
        }
      },
    );
  }

  return server;
}
