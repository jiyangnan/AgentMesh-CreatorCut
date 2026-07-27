import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@agentmesh/creatorcut-credentials": fileURLToPath(
        new URL("../../packages/credentials/src/index.ts", import.meta.url),
      ),
      "@agentmesh/creatorcut-director-client": fileURLToPath(
        new URL("../../packages/director-client/src/index.ts", import.meta.url),
      ),
      "@agentmesh/creatorcut-host-adapters": fileURLToPath(
        new URL("../../packages/host-adapters/src/index.ts", import.meta.url),
      ),
      "@agentmesh/creatorcut-runtime": fileURLToPath(
        new URL("../../packages/runtime/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
  },
});
