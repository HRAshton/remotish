import type { RemotishCapabilities } from './capabilities.js';
import type { CommitRequest, CommitResult } from './commit.js';
import type { BranchName, RepoPath, RevisionId } from './primitives.js';
import type {
  Branch,
  CommitChange,
  CommitPage,
  CommitQuery,
  DirectoryEntry,
  RepositoryInfo,
} from './repository.js';

/** Optional cancellation state passed to remote calls. */
export interface RemoteRequestOptions {
  readonly signal?: AbortSignal;
}

/**
 * Repository-semantic contract implemented by every Remotish backend.
 *
 * Adapters deliberately know nothing about VS Code, overlays, SCM resources, commands, or UI.
 */
export interface RemotishAdapter {
  /** Optional features implemented by this backend. */
  readonly capabilities: RemotishCapabilities;

  /** Reads repository metadata. */
  getRepository(options?: RemoteRequestOptions): Promise<RepositoryInfo>;

  /** Lists one directory at an immutable revision. */
  readDirectory(
    revision: RevisionId,
    path: RepoPath,
    options?: RemoteRequestOptions,
  ): Promise<readonly DirectoryEntry[]>;

  /** Reads a file as raw bytes at an immutable revision. */
  readFile(
    revision: RevisionId,
    path: RepoPath,
    options?: RemoteRequestOptions,
  ): Promise<Uint8Array>;

  /** Lists remote branches and their current head revisions. */
  getBranches(options?: RemoteRequestOptions): Promise<readonly Branch[]>;

  /** Reads commit history with adapter-defined pagination. */
  getCommits(request: CommitQuery, options?: RemoteRequestOptions): Promise<CommitPage>;

  /** Reads file-level changes for one immutable commit. */
  getCommitChanges(
    revision: RevisionId,
    options?: RemoteRequestOptions,
  ): Promise<readonly CommitChange[]>;

  /** Atomically creates a commit and publishes it, or returns a rejection when commits are supported. */
  commit?(request: CommitRequest, options?: RemoteRequestOptions): Promise<CommitResult>;

  /** Creates a remote branch when supported. */
  createBranch?(
    name: BranchName,
    revision: RevisionId,
    options?: RemoteRequestOptions,
  ): Promise<Branch>;

  /** Deletes a remote branch when supported. */
  deleteBranch?(name: BranchName, options?: RemoteRequestOptions): Promise<void>;
}
