import { describe, expect, it } from "vitest";

import {
  createPlatformCredentialStore,
  KeychainCredentialStore,
  LinuxSecretServiceCredentialStore,
  MemoryCredentialStore,
  WindowsDpapiCredentialStore,
  type KeychainCommandRunner,
  type PowerShellCommandRunner,
  type SecretToolCommandRunner,
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
      "add-generic-password -a agentmesh-api-key -s com.agentmesh.creatorcut -U -w am_live_secret\n",
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
      /-w am_test_key \/tmp\/creatorcut-cycle5\.keychain-db\n$/u,
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

  it("stores a Windows key through DPAPI stdin without putting it in the command", async () => {
    const calls: Array<{
      script: string;
      stdin?: string;
      environment?: NodeJS.ProcessEnv;
    }> = [];
    const runner: PowerShellCommandRunner = {
      async run(script, options) {
        calls.push({
          script,
          ...(options?.stdin ? { stdin: options.stdin } : {}),
          ...(options?.environment ? { environment: options.environment } : {}),
        });
        if (script.includes("Unprotect")) {
          return { stdout: "am_windows_key", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const store = new WindowsDpapiCredentialStore({
      path: "/tmp/creatorcut-test.dpapi",
      runner,
    });

    await store.setApiKey("am_windows_key");
    expect(await store.getApiKey()).toBe("am_windows_key");
    expect(calls[0]?.stdin).toBe("am_windows_key");
    expect(calls[0]?.script).not.toContain("am_windows_key");
    expect(calls[0]?.environment?.CREATORCUT_DPAPI_PATH).toBe(
      "/tmp/creatorcut-test.dpapi",
    );
    expect(store.storage).toBe("Windows DPAPI");
  });

  it("uses Linux Secret Service with the secret only on stdin", async () => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const runner: SecretToolCommandRunner = {
      async run(args, options) {
        calls.push({
          args,
          ...(options?.stdin ? { stdin: options.stdin } : {}),
        });
        if (args[0] === "lookup") {
          return { stdout: "am_linux_key\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const store = new LinuxSecretServiceCredentialStore({ runner });

    await store.setApiKey("am_linux_key");
    expect(await store.getApiKey()).toBe("am_linux_key");
    expect(calls[0]?.args).not.toContain("am_linux_key");
    expect(calls[0]?.stdin).toBe("am_linux_key\n");
    expect(await store.deleteApiKey()).toBe(true);
    expect(calls.at(-1)?.args[0]).toBe("clear");
    expect(store.storage).toBe("Linux Secret Service");
  });

  it("rejects unsupported platform factories instead of falling back to a plaintext file", () => {
    expect(() => createPlatformCredentialStore("aix")).toThrow(
      /does not support credential storage/u,
    );
  });
});
