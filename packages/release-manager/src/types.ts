import type { SignedArtifactKeyset } from "@agentmesh/creatorcut-protocol";

declare const verifiedReleaseManifest: unique symbol;

export interface ReleaseManifest {
  product: "creatorcut";
  channel: "stable";
  latest_client_version: string;
  minimum_supported_version: string;
  protocol_version: "1.0";
  git_tag: string;
  git_commit: string;
  artifact_sha256: string;
  published_at: string;
  required: boolean;
  notes_url: string;
  key_id: string;
  signature_algorithm: "Ed25519";
  signature: string;
}

export type VerifiedReleaseManifest = ReleaseManifest & {
  readonly [verifiedReleaseManifest]: true;
};

export interface VerifiedReleaseTrust {
  keyset: SignedArtifactKeyset;
  roots: ReadonlyMap<string, string>;
}

export interface ManagedInstallMetadata {
  schema_version: "creatorcut-managed-install/1.0";
  managed: true;
  install_type: "official-installer";
  repository: string;
  install_dir: string;
  version: string;
  git_tag: string;
  git_commit: string;
  artifact_sha256: string;
  release_keyset_version: number;
  installed_at: string;
}

export interface ActiveProjectTask {
  kind: "transcription" | "export";
  state: "queued" | "running" | "finalizing";
  path: string;
}

export type ReleaseCheck =
  | {
      status: "current";
      current_version: string;
      manifest: VerifiedReleaseManifest;
    }
  | {
      status: "update_available" | "update_required";
      current_version: string;
      latest_version: string;
      manifest: VerifiedReleaseManifest;
    };

export interface CommandResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export type RunCommand = (input: {
  cwd: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}) => Promise<CommandResult>;
