export interface CliEnvelope<T = unknown> {
  schema_version: "creatorcut-cli/1.0";
  ok: boolean;
  command: string;
  project_revision?: number;
  requires_user_action: boolean;
  user_prompt?: string;
  retryable: boolean;
  next_suggested?: string;
  next_argv?: string[];
  next_process?: {
    executable: string;
    argv: string[];
    cwd: string;
    env_overrides: Record<string, string>;
    shell: false;
  };
  next_openclaw?: {
    exec: {
      command: "creatorcut __openclaw-bridge";
      workdir: string;
      env: Record<string, string>;
      pty: boolean;
      background: boolean;
    };
    input:
      | { mode: "none" }
      | {
          mode: "json-line-v1";
          ready_marker: "CREATORCUT_OPENCLAW_JSON_READY";
          maximum_utf8_bytes: number;
        };
  };
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export interface CliIo {
  stdin: () => Promise<string>;
  stdout: (value: string) => void;
}
