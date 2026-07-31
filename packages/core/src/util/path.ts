import { normalizeRepoPath } from '@remotish/adapter-sdk';

export const normalizePath = normalizeRepoPath;

/** Parent path. */
export function parentPath(path: string): string | undefined {
  const normalized = normalizePath(path);
  if (!normalized) {
    return undefined;
  }
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}

/** Base name. */
export function baseName(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? normalized : normalized.slice(index + 1);
}

/** Is same or child. */
export function isSameOrChild(path: string, parent: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedParent = normalizePath(parent);
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

/** Is direct child. */
export function isDirectChild(path: string, parent: string): boolean {
  return parentPath(path) === normalizePath(parent);
}
