import type { RemotishCapabilities, RemotishErrorCode } from '@remotish/adapter-sdk';

/** Version 1 is JSON-safe; transports own framing, correlation and authentication. */
export const REMOTISH_RPC_VERSION = 1 as const;

/** All repository operations supported by the version 1 protocol. */
export type RpcOperation =
  | 'getRepository'
  | 'readDirectory'
  | 'readFile'
  | 'getBranches'
  | 'getCommits'
  | 'getCommitChanges'
  | 'commit'
  | 'createBranch'
  | 'deleteBranch';

/** One versioned request, with operation-specific JSON payload. */
export interface RpcRequest {
  readonly version: typeof REMOTISH_RPC_VERSION;
  readonly operation: RpcOperation;
  readonly payload: unknown;
}

/** Validated endpoint metadata supplied before a synchronous adapter is constructed. */
export interface RpcSession {
  readonly version: typeof REMOTISH_RPC_VERSION;
  readonly capabilities: RemotishCapabilities;
}

/** A transport must correlate each call and forward its signal to the remote request. */
export interface RpcTransport {
  request(request: RpcRequest, options?: { readonly signal?: AbortSignal }): Promise<unknown>;
}

/** A result or an operational failure. Remote exception text and stacks are never transferred. */
export type RpcResponse =
  | { readonly version: 1; readonly status: 'ok'; readonly result: unknown }
  | {
      readonly version: 1;
      readonly status: 'error';
      readonly error: { readonly code: RemotishErrorCode };
    };
