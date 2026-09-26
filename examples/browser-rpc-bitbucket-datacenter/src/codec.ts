import {
  type CommitChange,
  type CommitInfo,
  normalizeRepoPath,
  RemotishError,
} from '@remotish/adapter-sdk';

const SHA = /^[0-9a-f]{40}$/iu;

export function filePayload(value: unknown): { revision: string; path: string } {
  const data = object(value, 'file request');
  if (typeof data.path !== 'string') {
    throw malformed('path');
  }
  return { revision: revision(data.revision), path: repoPath(data.path) };
}

export function revisionPayload(value: unknown): string {
  return revision(object(value, 'revision request').revision);
}

export function revision(value: unknown): string {
  const result = text(value, 'revision');
  if (!SHA.test(result)) {
    throw new RemotishError('INVALID_REQUEST', 'A full commit hash is required.');
  }
  return result.toLowerCase();
}

export function remoteRevision(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA.test(value)) {
    throw malformed(label);
  }
  return value.toLowerCase();
}

export function branchName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 255 ||
    value === '@' ||
    value.startsWith('-') ||
    value.includes('..') ||
    value.includes('@{') ||
    value.includes('//') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    /[~^:?*\\]/u.test(value) ||
    value.includes('[') ||
    [...value].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    ) ||
    value.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock')) ||
    !wellFormed(value)
  ) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Bitbucket branch name.');
  }
  return value;
}

export function remoteBranchName(value: unknown, label: string): string {
  try {
    return branchName(value);
  } catch {
    throw malformed(label);
  }
}

export function pageStart(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Bitbucket page cursor.');
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Bitbucket page cursor.');
  }
  return result;
}

export function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw malformed('JSON response');
  }
}

export function repoPath(value: string): string {
  try {
    if (normalizeRepoPath(value) === value) {
      return value;
    }
  } catch {
    // Report one caller-facing path error for every malformed form.
  }
  throw new RemotishError('INVALID_REQUEST', 'Invalid Bitbucket repository path.');
}

export function encodedRepoPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function remotePath(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw malformed(label);
  }
  try {
    if (normalizeRepoPath(value) === value && value) {
      return value;
    }
  } catch {
    // Malformed remote data is an invalid response, not a caller error.
  }
  throw malformed(label);
}

export function commitInfo(value: unknown): CommitInfo {
  const data = object(value, 'commit');
  const parents = list(data.parents, 'commit.parents').map((parent) =>
    remoteRevision(object(parent, 'parent').id, 'commit parent.id'),
  );
  const author = data.author === undefined ? undefined : object(data.author, 'commit.author');
  const authorName = author === undefined ? undefined : optionalText(author.name, 'author.name');
  const timestamp = optionalInteger(data.authorTimestamp, 'commit.authorTimestamp');
  let authoredAt: string | undefined;
  if (timestamp !== undefined) {
    try {
      authoredAt = new Date(timestamp).toISOString();
    } catch {
      throw malformed('commit.authorTimestamp');
    }
  }
  return {
    revision: remoteRevision(data.id, 'commit.id'),
    parents,
    message: stringValue(data.message, 'commit.message'),
    ...(authorName ? { author: { name: authorName } } : {}),
    ...(authoredAt ? { authoredAt } : {}),
  };
}

export function commitChange(value: unknown): CommitChange {
  const data = object(value, 'commit change');
  const path = changePath(data.path, 'change.path');
  switch (data.type) {
    case 'ADD':
    case 'COPY':
      return { type: 'added', path };
    case 'DELETE':
      return { type: 'deleted', path };
    case 'MODIFY':
      return { type: 'modified', path };
    case 'MOVE':
      return {
        type: 'renamed',
        path,
        previousPath: changePath(data.srcPath, 'change.srcPath'),
      };
    default:
      throw malformed('change.type');
  }
}

export function page(value: unknown): {
  readonly values: readonly unknown[];
  readonly limit: number;
  readonly nextPageStart?: number;
} {
  const data = object(value, 'page');
  const values = list(data.values, 'page.values');
  const limit = integer(data.limit, 'page.limit');
  if (typeof data.isLastPage !== 'boolean') {
    throw malformed('page.isLastPage');
  }
  if (data.isLastPage) {
    return { values, limit };
  }
  return { values, limit, nextPageStart: integer(data.nextPageStart, 'page.nextPageStart') };
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw malformed(label);
  }
  return value as Record<string, unknown>;
}

export function list(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw malformed(label);
  }
  return value;
}

export function text(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (!result) {
    throw malformed(label);
  }
  return result;
}

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw malformed(label);
  }
  return value;
}

export function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label);
}

export function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw malformed(label);
  }
  return value;
}

export function optionalInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : integer(value, label);
}

export function malformed(label: string): RemotishError {
  return new RemotishError('UNKNOWN', `Invalid Bitbucket Data Center ${label}.`);
}

function changePath(value: unknown, label: string): string {
  const data = object(value, label);
  return remotePath(data.toString, `${label}.toString`);
}

function wellFormed(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}
