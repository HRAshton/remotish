import {
  type BranchName,
  type Change,
  type CommitInfo,
  type CommitRequest,
  type CommitResult,
  RemotishError,
  type RevisionId,
} from '@remotish/adapter-sdk';
import { applyChanges, cloneFiles } from './files.js';
import type { FixtureRepository, StoredCommit } from './model.js';
import { remoteChanged, success } from './support.js';

/** Applies commit, amend, and lease semantics to the in-memory fixture repository. */
export class FixtureCommitEngine {
  private sequence = 100;

  constructor(private readonly repository: FixtureRepository) {}

  execute(request: CommitRequest): CommitResult {
    const message = request.message.trim();
    if (!message) {
      throw new RemotishError('INVALID_REQUEST', 'Commit message is required.');
    }
    if (request.changes.length === 0 && request.type !== 'amend') {
      throw new RemotishError('INVALID_REQUEST', 'At least one working change is required.');
    }

    const actualHead = this.repository.branches.get(request.branch);
    if (!actualHead) {
      throw new RemotishError('NOT_FOUND', `Branch ${request.branch} does not exist.`);
    }
    this.requireCommit(request.baseRevision);

    if (request.push.mode === 'normal') {
      if (actualHead !== request.baseRevision) {
        return remoteChanged(actualHead);
      }
      return this.publish(
        request.branch,
        this.createChild(request.baseRevision, message, request.changes),
      );
    }

    if (actualHead !== request.push.expectedRevision) {
      return remoteChanged(actualHead);
    }
    if (request.type === 'amend') {
      if (request.push.expectedRevision !== request.baseRevision) {
        throw new RemotishError(
          'INVALID_REQUEST',
          'Amend lease must match the workspace base revision.',
        );
      }
      return this.publish(
        request.branch,
        this.createAmended(request.baseRevision, message, request.changes),
      );
    }

    return this.publish(
      request.branch,
      this.createChild(request.baseRevision, message, request.changes),
    );
  }

  private publish(branch: BranchName, stored: StoredCommit): CommitResult {
    this.repository.branches.set(branch, stored.info.revision);
    return success(stored.info);
  }

  private createChild(
    parent: RevisionId,
    message: string,
    changes: readonly Change[],
  ): StoredCommit {
    const files = cloneFiles(this.requireCommit(parent).files);
    applyChanges(files, changes);
    return this.store([parent], message, files);
  }

  private createAmended(
    revision: RevisionId,
    message: string,
    changes: readonly Change[],
  ): StoredCommit {
    const existing = this.requireCommit(revision);
    const files = cloneFiles(existing.files);
    applyChanges(files, changes);
    return this.store(existing.info.parents, message, files);
  }

  private store(
    parents: readonly RevisionId[],
    message: string,
    files: Map<string, Uint8Array>,
  ): StoredCommit {
    const revision = `fixture-${this.sequence++}`;
    const info: CommitInfo = {
      revision,
      parents: [...parents],
      message,
      author: { name: 'Fixture User', email: 'fixture@example.invalid' },
      authoredAt: new Date(Date.UTC(2026, 0, this.sequence)).toISOString(),
    };
    const stored = { info, files };
    this.repository.commits.set(revision, stored);
    return stored;
  }

  private requireCommit(revision: RevisionId): StoredCommit {
    const commit = this.repository.commits.get(revision);
    if (!commit) {
      throw new RemotishError('NOT_FOUND', `Revision ${revision} does not exist.`);
    }
    return commit;
  }
}
