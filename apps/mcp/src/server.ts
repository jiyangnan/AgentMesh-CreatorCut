import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { CreatorCutMcpService } from "./service.js";

const response = (value: Record<string, unknown>, summary: string) => ({
  content: [{ type: "text" as const, text: summary }],
  structuredContent: value,
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
            (output.presentation as Record<string, unknown>).text_fallback ??
              "CreatorCut cards ready.",
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

  return server;
}
