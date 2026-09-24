import {
  type Branch,
  type CommitChange,
  type CommitInfo,
  type CommitPage,
  type CommitQuery,
  type CommitRequest,
  type CommitResult,
  type DirectoryEntry,
  normalizeRepoPath,
  type RemotishCapabilities,
  RemotishError,
  type RemotishErrorCode,
  type RepositoryInfo,
} from '@remotish/adapter-sdk';

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

/** Validate metadata before exposing a usable adapter. */
export function decodeRpcSession(value: unknown): RpcSession {
  const session = record(value, 'session', ['version', 'capabilities']);
  version(session.version);
  const valueCaps = record(session.capabilities, 'capabilities', [
    'commits',
    'forceWithLease',
    'amend',
    'createBranch',
    'deleteBranch',
  ]);
  const commits = boolean(valueCaps.commits, 'capabilities.commits');
  const forceWithLease = optionalBoolean(valueCaps.forceWithLease, 'capabilities.forceWithLease');
  const amend = optionalBoolean(valueCaps.amend, 'capabilities.amend');
  const createBranch = optionalBoolean(valueCaps.createBranch, 'capabilities.createBranch');
  const deleteBranch = optionalBoolean(valueCaps.deleteBranch, 'capabilities.deleteBranch');
  if ((forceWithLease && !commits) || (amend && !forceWithLease)) {
    throw invalid('capability dependency');
  }
  return {
    version: REMOTISH_RPC_VERSION,
    capabilities: {
      commits,
      ...(forceWithLease === undefined ? {} : { forceWithLease }),
      ...(amend === undefined ? {} : { amend }),
      ...(createBranch === undefined ? {} : { createBranch }),
      ...(deleteBranch === undefined ? {} : { deleteBranch }),
    },
  };
}

/** Validate a request before an endpoint dispatches it. Unknown methods fail closed. */
export function decodeRpcRequest(value: unknown): RpcRequest {
  const request = record(value, 'request', ['version', 'operation', 'payload']);
  version(request.version);
  const operation = string(request.operation, 'operation');
  if (!isOperation(operation)) {
    throw invalid('operation');
  }
  return {
    version: REMOTISH_RPC_VERSION,
    operation,
    payload: decodeRequestPayload(operation, request.payload),
  };
}

/** Decode the complete envelope and operation-specific result. */
export function decodeRpcResponse(operation: RpcOperation, value: unknown): unknown {
  if (!isOperation(operation)) {
    throw invalid('operation');
  }
  const response = record(value, 'response', ['version', 'status', 'result', 'error']);
  version(response.version);
  if (response.status === 'error') {
    if ('result' in response) {
      throw invalid('error response');
    }
    const failure = record(response.error, 'error', ['code']);
    const code = string(failure.code, 'error.code');
    if (!isErrorCode(code)) {
      throw invalid('error.code');
    }
    throw new RemotishError(code, errorMessage(code));
  }
  if (response.status !== 'ok' || 'error' in response || !('result' in response)) {
    throw invalid('response status');
  }
  return decodeResult(operation, response.result);
}

/** Encode exact bytes without text decoding or Node APIs. */
export function encodeRpcBytes(bytes: Uint8Array): { readonly base64: string } {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return { base64: btoa(binary) };
}

/** Reject non-canonical or malformed base64 before constructing bytes. */
export function decodeRpcBytes(value: unknown): Uint8Array {
  const data = record(value, 'bytes', ['base64']);
  const base64 = string(data.base64, 'bytes.base64');
  // A repeated-group regex can overflow V8's stack on multi-megabyte files.
  if (base64.length % 4 !== 0) {
    throw invalid('bytes.base64');
  }
  for (let index = 0; index < base64.length; index += 1) {
    const code = base64.charCodeAt(index);
    if (
      !(
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 47 ||
        (code === 61 && index >= base64.length - 2)
      )
    ) {
      throw invalid('bytes.base64');
    }
  }
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw invalid('bytes.base64');
  }
  if (btoa(binary) !== base64) {
    throw invalid('bytes.base64');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Build the wire commit shape explicitly, preserving push mode and lease. */
export function encodeRpcCommit(request: CommitRequest): object {
  const changes = request.changes.map((change) =>
    change.type === 'delete'
      ? { type: change.type, path: change.path }
      : { type: change.type, path: change.path, content: encodeRpcBytes(change.content) },
  );
  return {
    type: request.type,
    branch: request.branch,
    baseRevision: request.baseRevision,
    message: request.message,
    changes,
    push:
      request.push.mode === 'normal'
        ? { mode: 'normal' }
        : { mode: 'force-with-lease', expectedRevision: request.push.expectedRevision },
  };
}

/** Safe failure envelope for endpoint implementations. */
export function encodeRpcFailure(code: RemotishErrorCode): RpcResponse {
  return { version: REMOTISH_RPC_VERSION, status: 'error', error: { code } };
}

/** Exact operation result envelope; file bytes use the explicit wire representation. */
export function encodeRpcSuccess(operation: RpcOperation, result: unknown): RpcResponse {
  const wireResult =
    operation === 'readFile' && result instanceof Uint8Array ? encodeRpcBytes(result) : result;
  // Validate locally too, so endpoint implementations cannot emit a success-shaped bad result.
  decodeResult(operation, wireResult);
  return { version: REMOTISH_RPC_VERSION, status: 'ok', result: wireResult };
}

function decodeRequestPayload(operation: RpcOperation, value: unknown): unknown {
  switch (operation) {
    case 'getRepository':
    case 'getBranches':
      return empty(value);
    case 'readDirectory':
    case 'readFile': {
      const payload = record(value, 'payload', ['revision', 'path']);
      return { revision: nonempty(payload.revision, 'revision'), path: path(payload.path) };
    }
    case 'getCommitChanges': {
      const payload = record(value, 'payload', ['revision']);
      return { revision: nonempty(payload.revision, 'revision') };
    }
    case 'getCommits':
      return query(value);
    case 'commit':
      return commitRequest(value);
    case 'createBranch': {
      const payload = record(value, 'payload', ['name', 'revision']);
      return {
        name: nonempty(payload.name, 'name'),
        revision: nonempty(payload.revision, 'revision'),
      };
    }
    case 'deleteBranch': {
      const payload = record(value, 'payload', ['name']);
      return { name: nonempty(payload.name, 'name') };
    }
  }
}

function decodeResult(operation: RpcOperation, value: unknown): unknown {
  switch (operation) {
    case 'getRepository':
      return repository(value);
    case 'readDirectory':
      return array(value, 'directory').map(directoryEntry);
    case 'readFile':
      return decodeRpcBytes(value);
    case 'getBranches':
      return array(value, 'branches').map(branch);
    case 'getCommits':
      return page(value);
    case 'getCommitChanges':
      return array(value, 'changes').map(commitChange);
    case 'commit':
      return commitResult(value);
    case 'createBranch':
      return branch(value);
    case 'deleteBranch':
      if (value !== null) {
        throw invalid('deleteBranch result');
      }
      return undefined;
  }
}

function repository(value: unknown): RepositoryInfo {
  const data = record(value, 'repository', ['id', 'name', 'defaultBranch', 'description']);
  const description = optionalString(data.description, 'description');
  return {
    id: nonempty(data.id, 'id'),
    name: nonempty(data.name, 'name'),
    defaultBranch: nonempty(data.defaultBranch, 'defaultBranch'),
    ...(description === undefined ? {} : { description }),
  };
}

function directoryEntry(value: unknown): DirectoryEntry {
  const data = record(value, 'entry', ['name', 'path', 'type', 'size']);
  const type = data.type;
  if (type !== 'file' && type !== 'directory') {
    throw invalid('entry.type');
  }
  const size = data.size;
  if (size !== undefined && (!Number.isSafeInteger(size) || typeof size !== 'number' || size < 0)) {
    throw invalid('entry.size');
  }
  const name = nonempty(data.name, 'entry.name');
  const entryPath = path(data.path);
  if (
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    entryPath.split('/').at(-1) !== name
  ) {
    throw invalid('entry.name');
  }
  return { name, path: entryPath, type, ...(size === undefined ? {} : { size }) };
}

function branch(value: unknown): Branch {
  const data = record(value, 'branch', ['name', 'revision', 'isDefault']);
  const isDefault = optionalBoolean(data.isDefault, 'branch.isDefault');
  return {
    name: nonempty(data.name, 'branch.name'),
    revision: nonempty(data.revision, 'branch.revision'),
    ...(isDefault === undefined ? {} : { isDefault }),
  };
}

function commitInfo(value: unknown): CommitInfo {
  const data = record(value, 'commit', ['revision', 'parents', 'message', 'author', 'authoredAt']);
  const author =
    data.author === undefined ? undefined : record(data.author, 'author', ['name', 'email']);
  const email = author === undefined ? undefined : optionalString(author.email, 'author.email');
  const authoredAt = optionalString(data.authoredAt, 'authoredAt');
  return {
    revision: nonempty(data.revision, 'commit.revision'),
    parents: array(data.parents, 'parents').map((item) => nonempty(item, 'parent')),
    message: string(data.message, 'commit.message'),
    ...(author === undefined
      ? {}
      : {
          author: {
            name: nonempty(author.name, 'author.name'),
            ...(email === undefined ? {} : { email }),
          },
        }),
    ...(authoredAt === undefined ? {} : { authoredAt }),
  };
}

function page(value: unknown): CommitPage {
  const data = record(value, 'page', ['commits', 'nextCursor']);
  const nextCursor = optionalString(data.nextCursor, 'nextCursor');
  return {
    commits: array(data.commits, 'commits').map(commitInfo),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function commitChange(value: unknown): CommitChange {
  const data = record(value, 'change', ['type', 'path', 'previousPath']);
  const type = data.type;
  if (type !== 'added' && type !== 'modified' && type !== 'deleted' && type !== 'renamed') {
    throw invalid('change.type');
  }
  const previousPath = data.previousPath === undefined ? undefined : path(data.previousPath);
  return { type, path: path(data.path), ...(previousPath === undefined ? {} : { previousPath }) };
}

function commitResult(value: unknown): CommitResult {
  const data = record(value, 'commit result', [
    'status',
    'revision',
    'commit',
    'reason',
    'remoteRevision',
    'message',
  ]);
  if (data.status === 'success') {
    if ('reason' in data || 'remoteRevision' in data || 'message' in data) {
      throw invalid('commit result');
    }
    const revision = nonempty(data.revision, 'revision');
    const commit = commitInfo(data.commit);
    if (commit.revision !== revision) {
      throw invalid('commit revision mismatch');
    }
    return { status: 'success', revision, commit };
  }
  if (data.status !== 'rejected' || 'revision' in data || 'commit' in data) {
    throw invalid('commit result');
  }
  const reason = data.reason;
  if (reason !== 'REMOTE_CHANGED' && reason !== 'FORBIDDEN' && reason !== 'UNSUPPORTED') {
    throw invalid('rejection reason');
  }
  const remoteRevision = optionalString(data.remoteRevision, 'remoteRevision');
  const message = optionalString(data.message, 'message');
  return {
    status: 'rejected',
    reason,
    ...(remoteRevision === undefined ? {} : { remoteRevision }),
    ...(message === undefined ? {} : { message }),
  };
}

function query(value: unknown): CommitQuery {
  const data = record(value, 'query', ['branch', 'revision', 'cursor', 'limit']);
  const branch = optionalString(data.branch, 'branch');
  const revision = optionalString(data.revision, 'revision');
  const cursor = optionalString(data.cursor, 'cursor');
  const limit = data.limit;
  if (
    limit !== undefined &&
    (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1)
  ) {
    throw invalid('limit');
  }
  return {
    ...(branch === undefined ? {} : { branch }),
    ...(revision === undefined ? {} : { revision }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function commitRequest(value: unknown): unknown {
  const data = record(value, 'commit request', [
    'type',
    'branch',
    'baseRevision',
    'message',
    'changes',
    'push',
  ]);
  const push = record(data.push, 'push', ['mode', 'expectedRevision']);
  if (push.mode === 'normal') {
    if (data.type !== 'commit' || 'expectedRevision' in push) {
      throw invalid('push');
    }
  } else if (push.mode !== 'force-with-lease') {
    throw invalid('push.mode');
  } else if (data.type !== 'commit' && data.type !== 'amend') {
    throw invalid('commit type');
  }
  const changes = array(data.changes, 'changes').map((item) => {
    const change = record(item, 'change', ['type', 'path', 'content']);
    if (change.type === 'delete') {
      if ('content' in change) {
        throw invalid('delete content');
      }
      return { type: 'delete', path: path(change.path) };
    }
    if (change.type !== 'add' && change.type !== 'modify') {
      throw invalid('change.type');
    }
    return { type: change.type, path: path(change.path), content: decodeRpcBytes(change.content) };
  });
  return {
    type: data.type,
    branch: nonempty(data.branch, 'branch'),
    baseRevision: nonempty(data.baseRevision, 'baseRevision'),
    message: string(data.message, 'message'),
    changes,
    push:
      push.mode === 'normal'
        ? { mode: 'normal' }
        : {
            mode: 'force-with-lease',
            expectedRevision: nonempty(push.expectedRevision, 'expectedRevision'),
          },
  };
}

function empty(value: unknown): object {
  return record(value, 'payload', []);
}
function path(value: unknown): string {
  const input = string(value, 'path');
  try {
    if (normalizeRepoPath(input) === input) {
      return input;
    }
  } catch {
    /* Reject below. */
  }
  throw invalid('path');
}
function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(label);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw invalid(label);
  }
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !keys.includes(key))) {
    throw invalid(label);
  }
  return data;
}
function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw invalid(label);
  }
  return value;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw invalid(label);
  }
  return value;
}
function nonempty(value: unknown, label: string): string {
  const result = string(value, label);
  if (!result) {
    throw invalid(label);
  }
  return result;
}
function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw invalid(label);
  }
  return value;
}
function optionalBoolean(value: unknown, label: string): boolean | undefined {
  return value === undefined ? undefined : boolean(value, label);
}
function version(value: unknown): void {
  if (value !== REMOTISH_RPC_VERSION) {
    throw invalid('protocol version');
  }
}
function isOperation(value: string): value is RpcOperation {
  return [
    'getRepository',
    'readDirectory',
    'readFile',
    'getBranches',
    'getCommits',
    'getCommitChanges',
    'commit',
    'createBranch',
    'deleteBranch',
  ].includes(value);
}
function isErrorCode(value: string): value is RemotishErrorCode {
  return [
    'NOT_FOUND',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'RATE_LIMITED',
    'OFFLINE',
    'UNSUPPORTED',
    'INVALID_REQUEST',
    'CANCELLED',
    'UNKNOWN',
  ].includes(value);
}
function errorMessage(code: RemotishErrorCode): string {
  return `Remote operation failed (${code}).`;
}
function invalid(label: string): RemotishError {
  return new RemotishError('UNKNOWN', `Invalid Remotish RPC ${label}.`);
}
