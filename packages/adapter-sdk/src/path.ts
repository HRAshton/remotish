import { RemotishError } from './errors.js';
import type { RepoPath } from './primitives.js';

/** Normalizes and validates a repository-relative path using forward slashes. */
export function normalizeRepoPath(path: string): RepoPath {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  const parts = normalized ? normalized.split('/') : [];
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new RemotishError('INVALID_REQUEST', `Invalid repository path: ${path}`);
  }
  return parts.join('/');
}
