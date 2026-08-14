import { normalizeRepoPath, type RepoPath, type RevisionId } from '@remotish/adapter-sdk';

/** URI scheme for editable working-tree resources. */
export const WORKING_SCHEME = 'remotish';
/** URI scheme for immutable revision resources. */
export const REVISION_SCHEME = 'remotish-base';

/** Minimal URI shape consumed by the repository URI parser. */
export interface RepositoryUriLike {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
}

/** Distinguishes editable working resources from immutable revision-pinned resources. */
export type RepositoryResource =
  | {
      readonly view: 'working';
      readonly workspaceId: string;
      readonly path: RepoPath;
    }
  | {
      readonly view: 'revision';
      readonly workspaceId: string;
      readonly path: RepoPath;
      readonly revision: RevisionId;
    };

/** Parsed repository identity, path, view, and optional revision encoded in a Remotish URI. */
export interface RepositoryUriParts {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query?: string;
}

/** Parses and validates a working or immutable Remotish repository URI. */
export function parseRepositoryUri(uri: RepositoryUriLike): RepositoryResource {
  const workspaceId = uri.authority.trim().toLowerCase();
  if (!workspaceId) {
    throw new Error('Repository URI requires a workspace authority.');
  }
  const path = normalizeRepoPath(uri.path);

  if (uri.scheme === WORKING_SCHEME) {
    return { view: 'working', workspaceId, path };
  }
  if (uri.scheme === REVISION_SCHEME) {
    const revision = new URLSearchParams(uri.query).get('revision')?.trim();
    if (!revision) {
      throw new Error('Revision URI requires a revision query parameter.');
    }
    return { view: 'revision', workspaceId, path, revision };
  }
  throw new Error(`Unsupported Remotish URI scheme: ${uri.scheme}`);
}

/** Encodes one editable repository path without binding it to a mutable branch-head revision. */
export function workingUriParts(workspaceId: string, path: RepoPath = ''): RepositoryUriParts {
  return {
    scheme: WORKING_SCHEME,
    authority: workspaceId,
    path: toUriPath(path),
  };
}

/** Encodes one immutable repository path pinned to a concrete revision in the URI query. */
export function revisionUriParts(
  workspaceId: string,
  revision: RevisionId,
  path: RepoPath = '',
): RepositoryUriParts {
  return {
    scheme: REVISION_SCHEME,
    authority: workspaceId,
    path: toUriPath(path),
    query: new URLSearchParams({ revision }).toString(),
  };
}

function toUriPath(path: RepoPath): string {
  const normalized = normalizeRepoPath(path);
  return normalized ? `/${normalized}` : '/';
}
