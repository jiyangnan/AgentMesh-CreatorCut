import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    ...(process.platform === "win32"
      ? { fileParallelism: false, testTimeout: 15_000 }
      : {}),
  },
});
