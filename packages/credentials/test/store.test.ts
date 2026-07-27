import { describe, expect, it } from "vitest";

import {
  KeychainCredentialStore,
  MemoryCredentialStore,
  type KeychainCommandRunner,
} from "../src/index.js";

describe("CreatorCut credential storage", () => {
  it("keeps the API key out of Keychain argv", async () => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const runner: KeychainCommandRunner = {
      async run(args, options) {
        calls.push({
          args,
          ...(options?.stdin ? { stdin: options.stdin } : {}),
        });
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const store = new KeychainCredentialStore({ runner });
    await store.setApiKey("am_live_secret");

    expect(calls[0]?.args).not.toContain("am_live_secret");
    expect(calls[0]?.args.at(-1)).toBe("-w");
    expect(calls[0]?.stdin).toBe("am_live_secret");
  });

  it("supports deterministic in-memory lifecycle tests", async () => {
    const store = new MemoryCredentialStore();
    expect(await store.hasApiKey()).toBe(false);
    await store.setApiKey("am_test_key");
    expect(await store.getApiKey()).toBe("am_test_key");
    expect(await store.deleteApiKey()).toBe(true);
    expect(await store.deleteApiKey()).toBe(false);
  });

  it("rejects whitespace and empty secrets", async () => {
    const store = new MemoryCredentialStore();
    await expect(store.setApiKey("bad key")).rejects.toThrow(/whitespace/u);
    await expect(store.setApiKey(" ")).rejects.toThrow(/non-empty/u);
  });
});
