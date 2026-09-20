import type { RemotishAdapter } from '@remotish/adapter-sdk';

/** Public API version exposed by the installed Remotish host extension. */
export const REMOTISH_EXTENSION_API_VERSION = 1 as const;

/** Minimal disposable shape shared with provider wrapper extensions. */
export interface RemotishDisposable {
  dispose(): void;
}

/** Provider-neutral request for opening one remote repository. */
export interface RemotishOpenRequest {
  readonly provider: string;
  readonly repository: Readonly<Record<string, string>>;
  readonly branch?: string;
  readonly path?: string;
}

/** Result returned after a repository has been opened by the Remotish host. */
export interface RemotishOpenResult {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly branch: string;
  readonly uri: string;
}

/** Registration supplied by an independently distributed provider wrapper extension. */
export interface RemotishProviderRegistration {
  readonly id: string;
  readonly displayName: string;

  createAdapter(
    repository: Readonly<Record<string, string>>,
  ): RemotishAdapter | Promise<RemotishAdapter>;
}

/** Version 1 of the public API returned from the Remotish host extension activation. */
export interface RemotishExtensionApiV1 {
  readonly version: typeof REMOTISH_EXTENSION_API_VERSION;

  registerProvider(provider: RemotishProviderRegistration): RemotishDisposable;

  openRepository(request: RemotishOpenRequest): Promise<RemotishOpenResult>;
}
