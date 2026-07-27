import { describe, expect, it } from "vitest";

import { buildPublicClientCapabilities } from "../src/index.js";

describe("public client capabilities", () => {
  it("builds the canonical profile for every supported host", () => {
    for (const hostType of [
      "codex",
      "claude_code",
      "openclaw",
      "text",
    ] as const) {
      const profile = buildPublicClientCapabilities(hostType, "0.1.7");
      expect(profile.host_type).toBe(hostType);
      expect(profile.client_version).toBe("0.1.7");
      expect(profile.operation_types).toHaveLength(13);
      expect(profile.supports_visual_previews).toBe(hostType === "codex");
      expect(profile.supports_voice_preview).toBe(hostType === "codex");
      expect(profile.card_types.includes("visual")).toBe(hostType === "codex");
      expect(profile.card_types.includes("voice")).toBe(hostType === "codex");
    }
  });
});
