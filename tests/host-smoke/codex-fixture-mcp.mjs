#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createCycle3FixtureService } from "./cycle3-fixture-service.mjs";

const root = resolve(import.meta.dirname, "../..");
const { createCreatorCutMcpServer } = await import(
  pathToFileURL(resolve(root, "apps/mcp/dist/src/server.js")).href
);

const service = await createCycle3FixtureService({
  hostType: process.env.CREATORCUT_HOST_TYPE ?? "codex",
  evidencePath: process.env.CREATORCUT_HOST_SMOKE_EVIDENCE,
});
const server = createCreatorCutMcpServer(service);
await server.connect(new StdioServerTransport());
