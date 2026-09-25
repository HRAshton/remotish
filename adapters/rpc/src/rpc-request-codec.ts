import type { CommitQuery, CommitRequest } from '@remotish/adapter-sdk';
import {
  array,
  boolean,
  decodeRpcBytes,
  encodeRpcBytes,
  invalid,
  isOperation,
  nonempty,
  optionalBoolean,
  optionalString,
  record,
  repoPath,
  requireVersion,
  string,
} from './rpc-codec-primitives.js';
import {
  REMOTISH_RPC_VERSION,
  type RpcOperation,
  type RpcRequest,
  type RpcSession,
} from './rpc-types.js';

/** Validate metadata before exposing a usable adapter. */
export function decodeRpcSession(value: unknown): RpcSession {
  const session = record(value, 'session', ['version', 'capabilities']);
  requireVersion(session.version);
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
  requireVersion(request.version);
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

/** Build the wire commit shape explicitly, preserving push mode and lease. */
export function encodeRpcCommit(request: CommitRequest): object {
  const changes = request.changes.map((change) =>
    change.type === 'delete'
      ? { type: change.type, path: change.path }
      : {
          type: change.type,
          path: change.path,
          content: encodeRpcBytes(change.content),
        },
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

function decodeRequestPayload(operation: RpcOperation, value: unknown): unknown {
  switch (operation) {
    case 'getRepository':
    case 'getBranches':
      return record(value, 'payload', []);
    case 'readDirectory':
    case 'readFile': {
      const payload = record(value, 'payload', ['revision', 'path']);
      return { revision: nonempty(payload.revision, 'revision'), path: repoPath(payload.path) };
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

function commitRequest(value: unknown): CommitRequest {
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
      return { type: 'delete' as const, path: repoPath(change.path) };
    }
    if (change.type !== 'add' && change.type !== 'modify') {
      throw invalid('change.type');
    }
    return {
      type: change.type as 'add' | 'modify',
      path: repoPath(change.path),
      content: decodeRpcBytes(change.content),
    };
  });

  const common = {
    branch: nonempty(data.branch, 'branch'),
    baseRevision: nonempty(data.baseRevision, 'baseRevision'),
    message: string(data.message, 'message'),
    changes,
  };
  if (push.mode === 'normal') {
    return { type: 'commit', ...common, push: { mode: 'normal' } };
  }
  const expectedRevision = nonempty(push.expectedRevision, 'expectedRevision');
  return data.type === 'amend'
    ? { type: 'amend', ...common, push: { mode: 'force-with-lease', expectedRevision } }
    : { type: 'commit', ...common, push: { mode: 'force-with-lease', expectedRevision } };
}
