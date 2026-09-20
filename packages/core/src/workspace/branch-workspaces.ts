import {
  type Branch,
  type BranchName,
  type RemotishAdapter,
  RemotishError,
  type RevisionId,
} from '@remotish/adapter-sdk';
import type { OverlaySnapshot } from '../overlay/overlay.js';
import type {
  BranchWorkspaceSnapshot,
  WorkspaceSnapshot,
} from '../persistence/workspace-storage.js';
import type { RepositoryReader } from '../repository/repository-reader.js';
import { WorkingTree } from '../working-tree/working-tree.js';

interface BranchWorkspace {
  readonly branch: BranchName;
  readonly tree: WorkingTree;
}

/** Maintains an independent pinned base and working overlay for every visited branch. */
export class BranchWorkspaces {
  private readonly workspaces = new Map<BranchName, BranchWorkspace>();
  private _selectedBranch: BranchName;

  private constructor(
    private readonly adapter: RemotishAdapter,
    private readonly repository: RepositoryReader,
    selectedBranch: BranchName,
  ) {
    this._selectedBranch = selectedBranch;
  }

  static async create(
    adapter: RemotishAdapter,
    repository: RepositoryReader,
    defaultBranch: BranchName,
    persisted?: WorkspaceSnapshot,
  ): Promise<BranchWorkspaces> {
    const manager = new BranchWorkspaces(
      adapter,
      repository,
      persisted?.selectedBranch ?? defaultBranch,
    );
    if (persisted) {
      for (const [branch, snapshot] of Object.entries(persisted.branches)) {
        manager.workspaces.set(
          branch,
          manager.createWorkspace(branch, snapshot.baseRevision, snapshot.overlay),
        );
      }
      if (manager.workspaces.has(manager._selectedBranch)) {
        return manager;
      }
    }
    await manager.ensureWorkspace(manager._selectedBranch);
    return manager;
  }

  get selectedBranch(): BranchName {
    return this._selectedBranch;
  }

  get current(): WorkingTree {
    const workspace = this.workspaces.get(this._selectedBranch);
    if (!workspace) {
      throw new Error(`Workspace for branch ${this._selectedBranch} is not initialized.`);
    }
    return workspace.tree;
  }

  async switchTo(branch: BranchName): Promise<void> {
    await this.ensureWorkspace(branch);
    this._selectedBranch = branch;
  }

  add(branch: Branch): void {
    const workspace = this.createWorkspace(branch.name, branch.revision);
    this.workspaces.set(branch.name, workspace);
  }

  remove(branch: BranchName): void {
    this.workspaces.delete(branch);
  }

  async listRemoteBranches(): Promise<readonly Branch[]> {
    return this.adapter.getBranches();
  }

  snapshot(): WorkspaceSnapshot {
    const branches = Object.create(null) as Record<BranchName, BranchWorkspaceSnapshot>;
    for (const [branch, workspace] of this.workspaces) {
      const snapshot = workspace.tree.snapshot();
      branches[branch] = { baseRevision: snapshot.baseRevision, overlay: snapshot.overlay };
    }
    return { version: 1, selectedBranch: this._selectedBranch, branches };
  }

  restore(snapshot: WorkspaceSnapshot): void {
    this.workspaces.clear();
    for (const [branch, branchSnapshot] of Object.entries(snapshot.branches)) {
      this.workspaces.set(
        branch,
        this.createWorkspace(branch, branchSnapshot.baseRevision, branchSnapshot.overlay),
      );
    }
    this._selectedBranch = snapshot.selectedBranch;
  }

  private async ensureWorkspace(branch: BranchName): Promise<void> {
    if (this.workspaces.has(branch)) {
      return;
    }
    const remote = (await this.adapter.getBranches()).find(
      (candidate) => candidate.name === branch,
    );
    if (!remote) {
      throw new RemotishError('NOT_FOUND', `Branch ${branch} does not exist.`);
    }
    this.workspaces.set(branch, this.createWorkspace(branch, remote.revision));
  }

  private createWorkspace(
    branch: BranchName,
    baseRevision: RevisionId,
    overlay?: OverlaySnapshot,
  ): BranchWorkspace {
    return { branch, tree: new WorkingTree(this.repository, baseRevision, overlay) };
  }
}
