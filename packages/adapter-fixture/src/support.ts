import {
  type CommitInfo,
  type CommitResult,
  type DirectoryEntry,
  RemotishError,
  type RevisionId,
} from '@remotish/adapter-sdk';

/** Clone commit info. */
export function cloneCommitInfo(info: CommitInfo): CommitInfo {
  return {
    ...info,
    parents: [...info.parents],
    ...(info.author ? { author: { ...info.author } } : {}),
  };
}

/** Success. */
export function success(info: CommitInfo): CommitResult {
  const commit = cloneCommitInfo(info);
  return { status: 'success', revision: commit.revision, commit };
}

/** Remote changed. */
export function remoteChanged(actual: RevisionId): CommitResult {
  return {
    status: 'rejected',
    reason: 'REMOTE_CHANGED',
    remoteRevision: actual,
    message: `Remote branch now points to ${actual}.`,
  };
}

/** Validate branch name. */
export function validateBranchName(name: string): string {
  const value = name.trim();
  if (
    !value ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('..') ||
    /[~^:?*[\\\s]/.test(value)
  ) {
    throw new RemotishError('INVALID_REQUEST', `Invalid branch name: ${name}`);
  }
  return value;
}

/** Compare directory entries. */
export function compareDirectoryEntries(left: DirectoryEntry, right: DirectoryEntry): number {
  if (left.type !== right.type) {
    return left.type === 'directory' ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

/** Parse cursor. */
export function parseCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const value = Number.parseInt(cursor, 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RemotishError('INVALID_REQUEST', `Invalid commit cursor: ${cursor}`);
  }
  return value;
}

export async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handle = globalThis.setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        globalThis.clearTimeout(handle);
        reject(new RemotishError('CANCELLED', 'Operation cancelled.'));
      },
      { once: true },
    );
  });
}
