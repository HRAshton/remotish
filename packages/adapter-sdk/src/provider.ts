import type { RemotishAdapter } from './adapter.js';

/** Public provider activation-result contract version. */
export const REMOTISH_ADAPTER_PROVIDER_API_VERSION = 1 as const;

/** Stable command payload/result version used for provider -> host operations. */
export const REMOTISH_REPOSITORY_COMMAND_VERSION = 1 as const;

/** Stable provider -> host command identifiers. */
export const REMOTISH_ENSURE_REPOSITORY_COMMAND = 'remotish.ensureRepository' as const;
export const REMOTISH_OPEN_REPOSITORY_COMMAND = 'remotish.openRepository' as const;
export const REMOTISH_REFRESH_PROVIDERS_COMMAND = 'remotish.refreshProviders' as const;

/** Provider-neutral repository descriptor used for bootstrap and restoration. */
export interface RemotishRepositoryRequest {
  readonly provider: string;
  readonly repository: Readonly<Record<string, string>>;
  readonly branch?: string;
  readonly path?: string;
}

/** Versioned payload accepted by Remotish repository commands. */
export interface RemotishRepositoryCommandV1 extends RemotishRepositoryRequest {
  readonly version: typeof REMOTISH_REPOSITORY_COMMAND_VERSION;
}

/** Versioned result returned by Remotish repository commands. */
export interface RemotishRepositoryResultV1 {
  readonly version: typeof REMOTISH_REPOSITORY_COMMAND_VERSION;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly branch: string;

  /** Canonical repository root: remotish://<stable-workspace-id>/ */
  readonly uri: string;

  /** Optional resource hint corresponding to RemotishRepositoryRequest.path. */
  readonly resourceUri?: string;
}

/** Browser-safe contract returned by independently installed provider extensions. */
export interface RemotishAdapterProviderV1 {
  readonly apiVersion: typeof REMOTISH_ADAPTER_PROVIDER_API_VERSION;
  readonly id: string;
  readonly displayName: string;

  /** Provider-specific validation for its repository descriptor. */
  validateRepository(repository: Readonly<Record<string, string>>): void;

  /** Constructs an adapter using provider-owned authentication/configuration. */
  createAdapter(
    repository: Readonly<Record<string, string>>,
  ): RemotishAdapter | Promise<RemotishAdapter>;

  /** Provider-owned reconstruction data for a previously opened canonical workspace. */
  restoreWorkspace?(workspaceId: string): Promise<RemotishRepositoryRequest | undefined>;
}
