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
export type {
  RemotishAdapterProviderV1,
  RemotishRepositoryCommandV1,
  RemotishRepositoryRequest,
  RemotishRepositoryResultV1,
} from './provider.js';
/** Public provider-extension contract and provider-neutral repository commands. */
export {
  REMOTISH_ADAPTER_PROVIDER_API_VERSION,
  REMOTISH_ENSURE_REPOSITORY_COMMAND,
  REMOTISH_OPEN_REPOSITORY_COMMAND,
  REMOTISH_REFRESH_PROVIDERS_COMMAND,
  REMOTISH_REPOSITORY_COMMAND_VERSION,
} from './provider.js';
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
