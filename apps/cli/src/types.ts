export interface CliEnvelope<T = unknown> {
  schema_version: "creatorcut-cli/1.0";
  ok: boolean;
  command: string;
  project_revision?: number;
  requires_user_action: boolean;
  user_prompt?: string;
  retryable: boolean;
  next_suggested?: string;
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
