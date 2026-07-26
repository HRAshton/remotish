import type { BranchName, RepoPath, RepositoryId, RevisionId } from './primitives.js';

/** Basic metadata describing one remote repository. */
export interface RepositoryInfo {
  /** Stable repository identifier. */
  readonly id: RepositoryId;

  /** Human-readable repository name. */
  readonly name: string;

  /** Default branch name reported by the remote. */
  readonly defaultBranch: BranchName;

  /** Optional repository description. */
  readonly description?: string;
}

/** Supported directory entry kinds. */
export type DirectoryEntryType = 'file' | 'directory';

/** One child entry returned by a directory listing. */
export interface DirectoryEntry {
  /** Final path segment. */
  readonly name: string;

  /** Repository-relative path. */
  readonly path: RepoPath;

  /** File or directory kind. */
  readonly type: DirectoryEntryType;

  /** Byte size when cheaply available. */
  readonly size?: number;
}

/** Remote branch and its current immutable revision. */
export interface Branch {
  /** Branch name. */
  readonly name: BranchName;

  /** Current branch head revision. */
  readonly revision: RevisionId;

  /** Whether this is the repository default branch. */
  readonly isDefault?: boolean;
}

/** Commit author metadata. */
export interface CommitAuthor {
  /** Display name. */
  readonly name: string;

  /** Optional email address. */
  readonly email?: string;
}

/** Immutable commit metadata. */
export interface CommitInfo {
  /** Commit revision identifier. */
  readonly revision: RevisionId;

  /** Parent revisions, in repository order. */
  readonly parents: readonly RevisionId[];

  /** Full commit message. */
  readonly message: string;

  /** Optional author metadata. */
  readonly author?: CommitAuthor;

  /** Optional ISO-8601 author timestamp. */
  readonly authoredAt?: string;
}

/** Change categories exposed by repository history. */
export type CommitChangeType = 'added' | 'modified' | 'deleted' | 'renamed';

/** File-level change belonging to an immutable commit. */
export interface CommitChange {
  /** Change category. */
  readonly type: CommitChangeType;

  /** Current repository-relative path. */
  readonly path: RepoPath;

  /** Previous path for a rename, when known. */
  readonly previousPath?: RepoPath;
}

/** Pagination and ref selection for commit history. */
export interface CommitQuery {
  /** Branch whose history should be read. */
  readonly branch?: BranchName;

  /** Specific revision whose ancestry should be read. */
  readonly revision?: RevisionId;

  /** Adapter-defined pagination cursor. */
  readonly cursor?: string;

  /** Maximum number of commits requested. */
  readonly limit?: number;
}

/** One page of commit history. */
export interface CommitPage {
  /** Commits in newest-first order. */
  readonly commits: readonly CommitInfo[];

  /** Cursor for the next page, when another page is available. */
  readonly nextCursor?: string;
}
