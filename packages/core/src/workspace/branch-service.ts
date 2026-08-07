import type { Branch, BranchName, RemotishAdapter, RevisionId } from '@remotish/adapter-sdk';
import { RemotishError } from '@remotish/adapter-sdk';
import type { BranchWorkspaces } from './branch-workspaces.js';

/** Result of comparing the selected workspace base with the branch's current remote head. */
export type RemoteHeadRefreshResult =
  | {
      readonly status: 'current' | 'updated';
      readonly baseRevision: RevisionId;
      readonly remoteRevision: RevisionId;
    }
  | {
      readonly status: 'pinned';
      readonly baseRevision: RevisionId;
      readonly remoteRevision: RevisionId;
    };

/** Implements branch switching/lifecycle and safe clean-vs-dirty remote-head refresh semantics. */
export class WorkspaceBranchService {
  constructor(
    private readonly adapter: RemotishAdapter,
    private readonly branches: BranchWorkspaces,
  ) {}

  switchTo(branch: BranchName): Promise<void> {
    return this.branches.switchTo(branch);
  }

  list(): Promise<readonly Branch[]> {
    return this.branches.listRemoteBranches();
  }

  async refresh(): Promise<RemoteHeadRefreshResult> {
    const branch = this.branches.selectedBranch;
    const remote = (await this.list()).find((candidate) => candidate.name === branch);
    if (!remote) {
      throw new RemotishError('NOT_FOUND', `Branch ${branch} does not exist.`);
    }
    const baseRevision = this.branches.current.baseRevision;
    if (remote.revision === baseRevision) {
      return { status: 'current', baseRevision, remoteRevision: remote.revision };
    }
    if (this.branches.current.hasChanges) {
      return { status: 'pinned', baseRevision, remoteRevision: remote.revision };
    }
    this.branches.current.rebindCleanBase(remote.revision);
    return { status: 'updated', baseRevision: remote.revision, remoteRevision: remote.revision };
  }

  async create(name: BranchName, switchTo = true): Promise<Branch> {
    if (!this.adapter.capabilities.createBranch || !this.adapter.createBranch) {
      throw new RemotishError('UNSUPPORTED', 'Adapter does not support branch creation.');
    }
    const branch = await this.adapter.createBranch(name, this.branches.current.baseRevision);
    this.branches.add(branch);
    if (switchTo) {
      await this.branches.switchTo(branch.name);
    }
    return branch;
  }

  async delete(name: BranchName): Promise<void> {
    if (name === this.branches.selectedBranch) {
      throw new RemotishError('INVALID_REQUEST', 'Cannot delete the currently selected branch.');
    }
    if (!this.adapter.capabilities.deleteBranch || !this.adapter.deleteBranch) {
      throw new RemotishError('UNSUPPORTED', 'Adapter does not support branch deletion.');
    }
    await this.adapter.deleteBranch(name);
    this.branches.remove(name);
  }
}
