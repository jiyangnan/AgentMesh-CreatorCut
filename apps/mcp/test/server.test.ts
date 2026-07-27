import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  CREATORCUT_CARD_WIDGET_URI,
  MCP_APP_MIME_TYPE,
  createCreatorCutMcpServer,
  type CreatorCutMcpService,
} from "../src/index.js";

const envelopeDigest = `sha256:${"1".repeat(64)}`;
const presentationDigest = `sha256:${"2".repeat(64)}`;
const renderDigest = `sha256:${"3".repeat(64)}`;
const presentation = {
  schema_version: "creatorcut-host-presentation/1.0",
  presentation_id: "presentation-mcp-widget",
  presentation_digest: presentationDigest,
  render_digest: renderDigest,
  host_type: "codex",
  card_set_id: "cards-widget",
  state_revision: 7,
  stage: "direction",
  cards: [
    {
      card_id: "platform",
      type: "single",
      title: "发布平台",
      prompt: "准备发布到哪里？",
      required: true,
      render_mode: "native",
      control: "radio",
      options: [
        {
          option_id: "xiaohongshu",
          submission_value: "1",
          label: "小红书",
        },
      ],
      default_option_ids: ["xiaohongshu"],
      fallback_text: "[platform] 发布平台\n1. 小红书",
    },
    {
      card_id: "confirm",
      type: "review",
      title: "确认方向",
      prompt: "确认后继续。",
      required: true,
      render_mode: "native",
      control: "approval",
      default_approved: false,
      fallback_text: "[confirm] 确认方向\nReply with approve or reject.",
    },
  ],
  text_fallback:
    "[platform] 发布平台\n1. 小红书\n\n[confirm] 确认方向\nReply with approve or reject.",
} as const;

const service = {
  getCards: async () => ({
    envelope_id: "cards-widget",
    envelope_digest: envelopeDigest,
    presentation_digest: presentationDigest,
    render_digest: renderDigest,
    presentation,
  }),
  renderCards: async (expected: {
    envelopeDigest?: string;
    presentationDigest?: string;
    renderDigest?: string;
  }) => {
    if (
      expected.presentationDigest !== undefined &&
      expected.presentationDigest !== presentationDigest
    ) {
      throw new TypeError(
        "CreatorCut card presentation changed; read the current cards again",
      );
    }
    return {
      answer_set_id: `answers:${"2".repeat(32)}`,
      envelope_id: "cards-widget",
      envelope_digest: envelopeDigest,
      presentation_digest: presentationDigest,
      render_digest: renderDigest,
      presentation,
    };
  },
} as unknown as CreatorCutMcpService;

let client: Client | undefined;
let server: ReturnType<typeof createCreatorCutMcpServer> | undefined;

afterEach(async () => {
  await client?.close();
  await server?.close();
  client = undefined;
  server = undefined;
});

async function connect(): Promise<Client> {
  server = createCreatorCutMcpServer(service);
  client = new Client({ name: "creatorcut-mcp-test", version: "0.1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

describe("CreatorCut MCP App", () => {
  it("publishes a deny-by-default, self-contained MCP App resource", async () => {
    const connected = await connect();
    const resources = await connected.listResources();
    expect(resources.resources).toContainEqual(
      expect.objectContaining({
        name: "creatorcut-decision-cards",
        uri: CREATORCUT_CARD_WIDGET_URI,
        mimeType: MCP_APP_MIME_TYPE,
      }),
    );

    const resource = await connected.readResource({
      uri: CREATORCUT_CARD_WIDGET_URI,
    });
    expect(resource.contents).toHaveLength(1);
    const content = resource.contents[0]!;
    expect(content).toMatchObject({
      uri: CREATORCUT_CARD_WIDGET_URI,
      mimeType: MCP_APP_MIME_TYPE,
      _meta: {
        ui: {
          prefersBorder: true,
          csp: { connectDomains: [], resourceDomains: [] },
        },
      },
    });
    expect("text" in content ? content.text : "").toContain(
      'name: "creatorcut_director_cards_submit"',
    );
    expect("text" in content ? content.text : "").toContain(
      "window.parent.postMessage",
    );
    expect("text" in content ? content.text : "").toContain(
      "event.source !== window.parent",
    );
    expect("text" in content ? content.text : "").not.toContain("innerHTML");
    expect("text" in content ? content.text : "").not.toMatch(/https?:\/\//);
  });

  it("keeps data and render tools separate and rejects stale rendering", async () => {
    const connected = await connect();
    const tools = await connected.listTools();
    const dataTool = tools.tools.find(
      (tool) => tool.name === "creatorcut_director_cards_get",
    );
    const renderTool = tools.tools.find(
      (tool) => tool.name === "creatorcut_director_cards_render",
    );
    expect(dataTool).toBeDefined();
    expect(dataTool?._meta).toBeUndefined();
    expect(renderTool?._meta).toMatchObject({
      ui: { resourceUri: CREATORCUT_CARD_WIDGET_URI },
      "openai/outputTemplate": CREATORCUT_CARD_WIDGET_URI,
    });

    const rendered = await connected.callTool({
      name: "creatorcut_director_cards_render",
      arguments: {
        expected_envelope_digest: envelopeDigest,
        expected_presentation_digest: presentationDigest,
        expected_render_digest: renderDigest,
      },
    });
    expect(rendered.isError).not.toBe(true);
    expect(rendered.structuredContent).toMatchObject({
      answer_set_id: `answers:${"2".repeat(32)}`,
      envelope_digest: envelopeDigest,
      presentation_digest: presentationDigest,
      render_digest: renderDigest,
      presentation,
    });

    const stale = await connected.callTool({
      name: "creatorcut_director_cards_render",
      arguments: {
        expected_presentation_digest: `sha256:${"9".repeat(64)}`,
      },
    });
    expect(stale.isError).toBe(true);
    expect(stale.content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("presentation changed"),
      }),
    );
  });
});
