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
    expect(calls[0]?.args).toEqual(["-i"]);
    expect(calls[0]?.stdin).toBe(
      "add-generic-password -a agentmesh-api-key -s com.agentmesh.creatorcut -U -w am_live_secret",
    );
  });

  it("supports deterministic in-memory lifecycle tests", async () => {
    const store = new MemoryCredentialStore();
    expect(await store.hasApiKey()).toBe(false);
    await store.setApiKey("am_test_key");
    expect(await store.getApiKey()).toBe("am_test_key");
    expect(await store.deleteApiKey()).toBe(true);
    expect(await store.deleteApiKey()).toBe(false);
  });

  it("targets an explicit isolated Keychain without changing the user default", async () => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const runner: KeychainCommandRunner = {
      async run(args, options) {
        calls.push({
          args,
          ...(options?.stdin ? { stdin: options.stdin } : {}),
        });
        return {
          stdout: args[0] === "find-generic-password" ? "am_test_key\n" : "",
          stderr: "",
          exitCode: 0,
        };
      },
    };
    const keychainPath = "/tmp/creatorcut-cycle5.keychain-db";
    const store = new KeychainCredentialStore({ runner, keychainPath });

    await store.setApiKey("am_test_key");
    expect(await store.getApiKey()).toBe("am_test_key");
    expect(await store.deleteApiKey()).toBe(true);

    expect(calls[0]?.args).toEqual(["-i"]);
    expect(calls[0]?.stdin).toMatch(
      /-w am_test_key \/tmp\/creatorcut-cycle5\.keychain-db$/u,
    );
    expect(calls[1]?.args.at(-1)).toBe(keychainPath);
    expect(calls[2]?.args.at(-1)).toBe(keychainPath);
    expect(calls.flatMap((call) => call.args)).not.toContain("am_test_key");
  });

  it("rejects whitespace and empty secrets", async () => {
    const store = new MemoryCredentialStore();
    await expect(store.setApiKey("bad key")).rejects.toThrow(/URL-safe/u);
    await expect(store.setApiKey(" ")).rejects.toThrow(/URL-safe/u);
  });
});
