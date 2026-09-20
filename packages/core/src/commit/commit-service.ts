import {
  type BranchName,
  type CommitRequest,
  type CommitResult,
  type RemotishAdapter,
  RemotishError,
  type RepoPath,
  type RevisionId,
} from '@remotish/adapter-sdk';
import type { WorkingTree } from '../working-tree/working-tree.js';

export type BeforeCommitPublish = (request: CommitRequest) => Promise<void>;
export type AfterCommitPublish = (
  result: Extract<CommitResult, { readonly status: 'success' }>,
) => Promise<void>;

export interface CommitExecutionResult {
  readonly result: CommitResult;
  readonly reconciliation: 'settled' | 'pending';
}

/** Builds adapter commit requests and advances only the published subset of a working tree on success. */
export class CommitService {
  constructor(private readonly adapter: RemotishAdapter) {}

  commitAndPush(
    branch: BranchName,
    tree: WorkingTree,
    message: string,
    selectedPaths?: readonly RepoPath[],
    beforePublish?: BeforeCommitPublish,
    afterPublish?: AfterCommitPublish,
  ): Promise<CommitExecutionResult> {
    return this.execute(
      branch,
      tree,
      message,
      { kind: 'normal' },
      selectedPaths,
      beforePublish,
      afterPublish,
    );
  }

  commitAndPushForceWithLease(
    branch: BranchName,
    tree: WorkingTree,
    message: string,
    expectedRevision: RevisionId,
    selectedPaths?: readonly RepoPath[],
    beforePublish?: BeforeCommitPublish,
    afterPublish?: AfterCommitPublish,
  ): Promise<CommitExecutionResult> {
    if (!this.adapter.capabilities.forceWithLease) {
      throw new RemotishError('UNSUPPORTED', 'Adapter does not support force-with-lease.');
    }

    return this.execute(
      branch,
      tree,
      message,
      { kind: 'force', expectedRevision },
      selectedPaths,
      beforePublish,
      afterPublish,
    );
  }

  amendAndPushForceWithLease(
    branch: BranchName,
    tree: WorkingTree,
    message: string,
    selectedPaths?: readonly RepoPath[],
    beforePublish?: BeforeCommitPublish,
    afterPublish?: AfterCommitPublish,
  ): Promise<CommitExecutionResult> {
    if (!this.adapter.capabilities.amend || !this.adapter.capabilities.forceWithLease) {
      throw new RemotishError(
        'UNSUPPORTED',
        'Adapter does not support amend with force-with-lease.',
      );
    }

    return this.execute(
      branch,
      tree,
      message,
      {
        kind: 'amend',
        expectedRevision: tree.baseRevision,
      },
      selectedPaths,
      beforePublish,
      afterPublish,
    );
  }

  private async execute(
    branch: BranchName,
    tree: WorkingTree,
    message: string,
    operation:
      | { readonly kind: 'normal' }
      | { readonly kind: 'force'; readonly expectedRevision: RevisionId }
      | { readonly kind: 'amend'; readonly expectedRevision: RevisionId },
    selectedPaths?: readonly RepoPath[],
    beforePublish?: BeforeCommitPublish,
    afterPublish?: AfterCommitPublish,
  ): Promise<CommitExecutionResult> {
    const commit = this.adapter.commit;
    if (!this.adapter.capabilities.commits || !commit) {
      throw new RemotishError('UNSUPPORTED', 'Adapter does not support commit publication.');
    }

    const trimmed = message.trim();
    if (!trimmed) {
      throw new RemotishError('INVALID_REQUEST', 'Commit message is required.');
    }

    const changes = await tree.buildCommitChanges(selectedPaths);
    if (changes.length === 0 && operation.kind !== 'amend') {
      throw new RemotishError('INVALID_REQUEST', 'There are no selected changes to commit.');
    }

    const baseRevision = tree.baseRevision;
    let request: CommitRequest;

    if (operation.kind === 'normal') {
      request = {
        type: 'commit',
        branch,
        baseRevision,
        message: trimmed,
        changes,
        push: { mode: 'normal' },
      };
    } else if (operation.kind === 'force') {
      request = {
        type: 'commit',
        branch,
        baseRevision,
        message: trimmed,
        changes,
        push: {
          mode: 'force-with-lease',
          expectedRevision: operation.expectedRevision,
        },
      };
    } else {
      request = {
        type: 'amend',
        branch,
        baseRevision,
        message: trimmed,
        changes,
        push: {
          mode: 'force-with-lease',
          expectedRevision: operation.expectedRevision,
        },
      };
    }

    await beforePublish?.(request);
    const result = await commit.call(this.adapter, request);
    if (result.status !== 'success') {
      return { result, reconciliation: 'settled' };
    }

    try {
      await afterPublish?.(result);
    } catch {
      // Publication already succeeded. Journal persistence cannot turn it back into a failure.
    }

    if (selectedPaths === undefined) {
      tree.acceptPublishedRevision(result.revision);
      return { result, reconciliation: 'settled' };
    }

    try {
      await tree.acceptPartiallyPublishedRevision(result.revision);
      return { result, reconciliation: 'settled' };
    } catch {
      return { result, reconciliation: 'pending' };
    }
  }
}
