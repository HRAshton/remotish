import type { RemotishAdapter } from '@remotish/adapter-sdk';

/** Public API version exposed by the installed Remotish host extension. */
export const REMOTISH_EXTENSION_API_VERSION = 1 as const;

/** Persisted format version for stable Remotish workspace authorities. */
export const REMOTISH_WORKSPACE_ID_FORMAT_VERSION = 1 as const;

/** Minimal disposable shape shared with provider wrapper extensions. */
export interface RemotishDisposable {
  dispose(): void;
}

/** Provider-neutral request for preparing or opening one remote repository. */
export interface RemotishOpenRequest {
  readonly provider: string;
  readonly repository: Readonly<Record<string, string>>;
  readonly branch?: string;
  readonly path?: string;

  /**
   * Canonical authority expected during restoration. Provider wrappers obtain this from their
   * persisted record, not from an untrusted bootstrap URL.
   */
  readonly expectedWorkspaceId?: string;
}

/** Required shape whenever an open request is serialized into bootstrap/persistence data. */
export interface SerializedRemotishOpenRequestV1 extends RemotishOpenRequest {
  readonly version: 1;
}

/** Provider-owned, non-secret reconstruction record. */
export interface PersistedProviderWorkspaceV1 {
  readonly version: 1;
  readonly workspaceId: string;
  readonly provider: string;
  readonly repository: Readonly<Record<string, string>>;
  readonly lastBranch?: string;
}

/** Result returned after a repository has been prepared by the Remotish host. */
export interface RemotishOpenResult {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly branch: string;

  /** Canonical repository root: remotish://<stable-workspace-id>/ */
  readonly uri: string;

  /** Optional resource hint corresponding to RemotishOpenRequest.path. */
  readonly resourceUri?: string;
}

/** Registration supplied by an independently distributed provider wrapper extension. */
export interface RemotishProviderRegistration {
  readonly id: string;
  readonly displayName: string;

  /** Exact VS Code extension id used to reactivate the provider after a canonical reload. */
  readonly extensionId: string;

  /** Provider-specific validation for allowed keys, required keys, bounds, and characters. */
  validateRepository(repository: Readonly<Record<string, string>>): void;

  createAdapter(
    repository: Readonly<Record<string, string>>,
  ): RemotishAdapter | Promise<RemotishAdapter>;
}

/** Version 1 of the public API returned from the Remotish host extension activation. */
export interface RemotishExtensionApiV1 {
  readonly version: typeof REMOTISH_EXTENSION_API_VERSION;

  registerProvider(provider: RemotishProviderRegistration): RemotishDisposable;

  /** Prepares/restores a workspace without changing the currently opened VS Code folder. */
  ensureRepository(request: RemotishOpenRequest): Promise<RemotishOpenResult>;

  /** Calls ensureRepository(), then navigates to the canonical workspace root. */
  openRepository(request: RemotishOpenRequest): Promise<RemotishOpenResult>;
}
