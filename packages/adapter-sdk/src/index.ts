/** Public adapter contract. */
export type { RemoteRequestOptions, RemotishAdapter } from './adapter.js';
/** Public capability declaration. */
export type { RemotishCapabilities } from './capabilities.js';
/** Public commit and publication model. */
export type {
  AmendCommitRequest,
  Change,
  CommitRejected,
  CommitRejectionReason,
  CommitRequest,
  CommitResult,
  CommitSuccess,
  ForceCommitRequest,
  NormalCommitRequest,
} from './commit.js';
export type { RemotishErrorCode } from './errors.js';
/** Structured errors adapters use at the framework boundary. */
export { RemotishError } from './errors.js';
/** Repository-path normalization shared by adapter implementations. */
export { normalizeRepoPath } from './path.js';
/** Public identifier primitives. */
export type { BranchName, RepoPath, RepositoryId, RevisionId } from './primitives.js';
/** Public immutable repository and history model. */
export type {
  Branch,
  CommitAuthor,
  CommitChange,
  CommitChangeType,
  CommitInfo,
  CommitPage,
  CommitQuery,
  DirectoryEntry,
  DirectoryEntryType,
  RepositoryInfo,
} from './repository.js';
