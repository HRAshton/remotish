import {
  type CommitInfo,
  type CommitRejected,
  normalizeRepoPath,
  RemotishError,
} from '@remotish/adapter-sdk';

const API_ORIGIN = 'https://api.bitbucket.org';
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

export function createdCommitRevision(location: string | undefined, basePath: string): string {
  if (!location || location.length > 2048) {
    throw malformed('published commit location');
  }
  let url: URL;
  try {
    url = new URL(location, API_ORIGIN);
  } catch {
    throw malformed('published commit location');
  }
  const prefix = `${basePath}/commit/`;
  if (
    url.origin !== API_ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(prefix)
  ) {
    throw malformed('published commit location');
  }
  const value = url.pathname.slice(prefix.length);
  if (!SHA.test(value) || url.pathname !== `${prefix}${value}`) {
    throw malformed('published commit location');
  }
  return value.toLowerCase();
}

export function prePublicationRejection(error: unknown): CommitRejected {
  const code = error instanceof RemotishError ? error.code : 'UNKNOWN';
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
    return {
      status: 'rejected',
      reason: 'FORBIDDEN',
      message: 'Bitbucket commit authorization failed before publication.',
    };
  }
  return {
    status: 'rejected',
    reason: 'UNSUPPORTED',
    message: `Bitbucket commit preflight failed before publication (${code}). No write was attempted.`,
  };
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
    // Report the same generic path error for every malformed form.
  }
  throw new RemotishError('INVALID_REQUEST', 'Invalid Bitbucket repository path.');
}

export function optionalPath(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : remotePath(object(value, label).path, `${label}.path`);
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
    // A malformed remote path is an invalid response, not a caller error.
  }
  throw malformed(label);
}

export function commitInfo(value: unknown): CommitInfo {
  const data = object(value, 'commit');
  const parents = list(data.parents, 'commit.parents').map((parent) =>
    remoteRevision(object(parent, 'parent').hash, 'commit parent.hash'),
  );
  const author = data.author === undefined ? undefined : object(data.author, 'commit.author');
  const rawAuthor = author === undefined ? undefined : optionalText(author.raw, 'author.raw');
  const date = optionalText(data.date, 'commit.date');
  if (
    date !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(date) ||
      Number.isNaN(Date.parse(date)))
  ) {
    throw malformed('commit.date');
  }
  return {
    revision: remoteRevision(data.hash, 'commit.hash'),
    parents,
    message: stringValue(data.message, 'commit.message'),
    ...(rawAuthor ? { author: { name: rawAuthor } } : {}),
    ...(date ? { authoredAt: date } : {}),
  };
}

export function page(value: unknown): { values: readonly unknown[]; next?: string } {
  const data = object(value, 'page');
  const next = data.next === null ? undefined : optionalText(data.next, 'page.next');
  return { values: list(data.values, 'page.values'), ...(next ? { next } : {}) };
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

export function malformed(label: string): RemotishError {
  return new RemotishError('UNKNOWN', `Invalid Bitbucket ${label}.`);
}

export function wellFormed(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}
