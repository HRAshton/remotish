import {
  type Branch,
  type BranchName,
  RemotishError,
  type RevisionId,
} from '@remotish/adapter-sdk';
import type { FixtureRepository } from './model.js';
import type { FixtureRepositoryView } from './repository-view.js';
import { validateBranchName } from './support.js';

/** Owns fixture branch listing, creation, deletion, and simulated remote head movement. */
export class FixtureBranchService {
  constructor(
    private readonly repository: FixtureRepository,
    private readonly view: FixtureRepositoryView,
  ) {}

  create(name: BranchName, revision: RevisionId): Branch {
    const normalized = validateBranchName(name);
    this.view.requireCommit(revision);
    if (this.repository.branches.has(normalized)) {
      throw new RemotishError('INVALID_REQUEST', `Branch ${normalized} already exists.`);
    }
    this.repository.branches.set(normalized, revision);
    return { name: normalized, revision };
  }

  delete(name: BranchName): void {
    if (name === this.repository.info.defaultBranch) {
      throw new RemotishError('INVALID_REQUEST', 'The default branch cannot be deleted.');
    }
    if (!this.repository.branches.delete(name)) {
      throw new RemotishError('NOT_FOUND', `Branch ${name} does not exist.`);
    }
  }

  moveHead(branch: BranchName, revision: RevisionId): void {
    if (!this.repository.branches.has(branch)) {
      throw new RemotishError('NOT_FOUND', `Branch ${branch} does not exist.`);
    }
    this.view.requireCommit(revision);
    this.repository.branches.set(branch, revision);
  }

  head(branch: BranchName): RevisionId {
    const revision = this.repository.branches.get(branch);
    if (!revision) {
      throw new RemotishError('NOT_FOUND', `Branch ${branch} does not exist.`);
    }
    return revision;
  }
}
