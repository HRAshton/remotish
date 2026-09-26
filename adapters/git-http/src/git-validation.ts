import { type CommitInfo, normalizeRepoPath, RemotishError } from '@remotish/adapter-sdk';
import type * as git from 'isomorphic-git';

export const ZERO_OID = '0'.repeat(40);
export const MAX_HISTORY = 10_000;
export const MAX_BRANCHES = 10_000;
export const MAX_TREE_ENTRIES = 100_000;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/u;

export function requireRevision(value: string): string {
  if (!SHA.test(value)) {
    throw new RemotishError('INVALID_REQUEST', 'Expected a full Git commit SHA.');
  }
  return value;
}

export function requireBranch(value: string): string {
  if (
    !value ||
    value === '@' ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.startsWith('.') ||
    value.endsWith('.') ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    value.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock')) ||
    [...value].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    ) ||
    /[~^:?*]/u.test(value) ||
    value.includes('[') ||
    value.includes('\\')
  ) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git branch name.');
  }
  return value;
}

export function requireRepoPath(value: string): string {
  const path = normalizeRepoPath(value);
  if (value !== path || path.startsWith('.git/') || path === '.git') {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git repository path.');
  }
  return path;
}

export function toCommitInfo(oid: string, commit: git.CommitObject): CommitInfo {
  return {
    revision: oid,
    parents: commit.parent,
    message: commit.message,
    author: { name: commit.author.name, email: commit.author.email },
    authoredAt: new Date(commit.author.timestamp * 1000).toISOString(),
  };
}

export function requireNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new RemotishError('CANCELLED', 'Git operation cancelled.');
  }
}
