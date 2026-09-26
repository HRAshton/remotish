import {
  type Branch,
  type CommitChange,
  type CommitInfo,
  type CommitPage,
  type CommitResult,
  type DirectoryEntry,
  RemotishError,
  type RemotishErrorCode,
  type RepositoryInfo,
} from '@remotish/adapter-sdk';
import {
  array,
  decodeRpcBytes,
  encodeRpcBytes,
  errorMessage,
  invalid,
  isErrorCode,
  isOperation,
  nonempty,
  optionalBoolean,
  optionalString,
  record,
  repoPath,
  requireVersion,
  string,
} from './rpc-codec-primitives.js';
import { REMOTISH_RPC_VERSION, type RpcOperation, type RpcResponse } from './rpc-types.js';

/** Decode the complete envelope and operation-specific result. */
export function decodeRpcResponse(operation: RpcOperation, value: unknown): unknown {
  if (!isOperation(operation)) {
    throw invalid('operation');
  }
  const response = record(value, 'response', ['version', 'status', 'result', 'error']);
  requireVersion(response.version);
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
  return decodeRpcResult(operation, response.result);
}

/** Safe failure envelope for endpoint implementations. */
export function encodeRpcFailure(code: RemotishErrorCode): RpcResponse {
  return { version: REMOTISH_RPC_VERSION, status: 'error', error: { code } };
}

/** Exact operation result envelope; file bytes use the explicit wire representation. */
export function encodeRpcSuccess(operation: RpcOperation, result: unknown): RpcResponse {
  const wireResult =
    operation === 'readFile' && result instanceof Uint8Array ? encodeRpcBytes(result) : result;
  decodeRpcResult(operation, wireResult);
  return { version: REMOTISH_RPC_VERSION, status: 'ok', result: wireResult };
}

function decodeRpcResult(operation: RpcOperation, value: unknown): unknown {
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
  if (size !== undefined && (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)) {
    throw invalid('entry.size');
  }
  const name = nonempty(data.name, 'entry.name');
  const entryPath = repoPath(data.path);
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
  const previousPath = data.previousPath === undefined ? undefined : repoPath(data.previousPath);
  return {
    type,
    path: repoPath(data.path),
    ...(previousPath === undefined ? {} : { previousPath }),
  };
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
