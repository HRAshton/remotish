import { normalizeRepoPath } from '@remotish/adapter-sdk';

export const normalizePath = normalizeRepoPath;

/** Parent path. */
export function parentPath(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}
