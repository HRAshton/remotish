import type { BranchName, RepoPath, RevisionId } from './primitives.js';
import type { CommitInfo } from './repository.js';

/** One uncommitted working-tree change supplied to the remote publisher. */
export type Change =
  | {
      readonly type: 'add' | 'modify';
      readonly path: RepoPath;
      readonly content: Uint8Array;
    }
  | {
      readonly type: 'delete';
      readonly path: RepoPath;
    };

interface CommitRequestBase {
  readonly branch: BranchName;
  readonly baseRevision: RevisionId;
  readonly message: string;
  readonly changes: readonly Change[];
}

/** Fast-forward commit-and-push request. */
export interface NormalCommitRequest extends CommitRequestBase {
  readonly type: 'commit';
  readonly push: {
    readonly mode: 'normal';
  };
}

/** Commit-and-push request that may replace history only while its lease matches. */
export interface ForceCommitRequest extends CommitRequestBase {
  readonly type: 'commit';
  readonly push: {
    readonly mode: 'force-with-lease';
    readonly expectedRevision: RevisionId;
  };
}

/** Amend request that replaces the current remote commit using force-with-lease. */
export interface AmendCommitRequest extends CommitRequestBase {
  readonly type: 'amend';
  readonly push: {
    readonly mode: 'force-with-lease';
    readonly expectedRevision: RevisionId;
  };
}

/** All commit-and-publish operations supported by the framework. */
export type CommitRequest = NormalCommitRequest | ForceCommitRequest | AmendCommitRequest;

/** Stable reasons why a remote publication can be rejected. */
export type CommitRejectionReason = 'REMOTE_CHANGED' | 'FORBIDDEN' | 'UNSUPPORTED';

/** Successful remote publication result. */
export interface CommitSuccess {
  readonly status: 'success';
  readonly revision: RevisionId;
  readonly commit: CommitInfo;
}

/** Rejected publication result. The workspace must remain unchanged. */
export interface CommitRejected {
  readonly status: 'rejected';
  readonly reason: CommitRejectionReason;
  readonly remoteRevision?: RevisionId;
  readonly message?: string;
}

/** Result of a commit-and-publish operation. */
export type CommitResult = CommitSuccess | CommitRejected;
