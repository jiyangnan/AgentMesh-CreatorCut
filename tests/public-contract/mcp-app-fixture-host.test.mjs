import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dirname, "../..");
const runner = resolve(root, "tests", "host-smoke", "codex-fixture-mcp.mjs");

test("Codex fixture stdio host renders and submits the locked AnswerSet", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [runner],
    env: {
      ...process.env,
      CREATORCUT_HOST_TYPE: "codex",
    },
  });
  const client = new Client({
    name: "creatorcut-cycle3-host-contract",
    version: "0.1.0",
  });
  await client.connect(transport);
  try {
    const resources = await client.listResources();
    assert.ok(
      resources.resources.some(
        (resource) =>
          resource.uri === "ui://creatorcut/decision-cards-v1.html" &&
          resource.mimeType === "text/html;profile=mcp-app",
      ),
    );

    const rendered = await client.callTool({
      name: "creatorcut_director_cards_render",
      arguments: {},
    });
    assert.equal(rendered.isError, undefined);
    assert.equal(
      rendered.structuredContent.answer_set_id,
      "answers-direction-cycle3-closeout-v1",
    );
    assert.equal(
      rendered.structuredContent.presentation_digest,
      "sha256:c6414585af75d434a3220d420938e08907c82a3a88a2720583b4b4019705dc15",
    );
    assert.equal(rendered.structuredContent.presentation.host_type, "codex");

    const submission = {
      answer_set_id: "answers-direction-cycle3-closeout-v1",
      presentation_id: rendered.structuredContent.presentation.presentation_id,
      presentation_digest:
        rendered.structuredContent.presentation.presentation_digest,
      responses: [
        {
          card_id: "card_platform",
          selected_values: ["platform_generic"],
        },
        {
          card_id: "card_target_duration",
          selected_values: ["target_keep_original"],
        },
        {
          card_id: "card_pace",
          selected_values: ["pace_natural"],
        },
        {
          card_id: "card_must_keep",
          selected_values: ["keep_result"],
        },
        {
          card_id: "card_terms",
          text_value:
            "CreatorCut、Export the final video、Export、the、final、video",
        },
        {
          card_id: "card_caption_style",
          selected_values: ["caption_clean"],
        },
        {
          card_id: "card_voice",
          selected_values: ["voice_original"],
        },
        { card_id: "card_review", approved: true },
      ],
    };
    const submitted = await client.callTool({
      name: "creatorcut_director_cards_submit",
      arguments: submission,
    });
    assert.equal(submitted.isError, undefined);
    assert.equal(
      submitted.structuredContent.state.answer_set_digest,
      "sha256:cfe3d574a3a99fa359a73d0494340546b9c6af0ab2b7013498f35aae9237b82f",
    );
  } finally {
    await client.close();
  }
});
