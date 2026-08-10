import type { BranchName, CommitInfo, RepositoryInfo, RevisionId } from '@remotish/adapter-sdk';

/** Immutable commit record stored by the deterministic in-memory fixture repository. */
export interface StoredCommit {
  readonly info: CommitInfo;
  readonly files: Map<string, Uint8Array>;
}

/** Mutable fixture graph used to simulate branches, commits, and remote head movement. */
export interface FixtureRepository {
  readonly info: RepositoryInfo;
  readonly commits: Map<RevisionId, StoredCommit>;
  readonly branches: Map<BranchName, RevisionId>;
}
