import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@agentmesh/creatorcut-host-adapters": fileURLToPath(
        new URL("../host-adapters/src/index.ts", import.meta.url),
      ),
      "@agentmesh/creatorcut-runtime": fileURLToPath(
        new URL("../runtime/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
  },
});
