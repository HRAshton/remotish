import {
  type BranchName,
  RemotishError,
  type RepoPath,
  type RevisionId,
} from '@remotish/adapter-sdk';
import type {
  Disposable as CoreDisposable,
  RemotishWorkspace,
  WorkingTreeChange,
} from '@remotish/core';
import * as vscode from 'vscode';
import { createRevisionUri, createWorkingUri, resourcePath } from '../filesystem/provider.js';
import { toScmChangeResource } from './change-resource.js';

/** Stable command identifiers used by native SCM resources, menus, and action buttons. */
export const SCM_COMMANDS = {
  commitAndPush: 'remotish.commitAndPush',
  commitAndPushForceWithLease: 'remotish.commitAndPushForceWithLease',
  amendAndPushForceWithLease: 'remotish.amendAndPushForceWithLease',
  openChange: 'remotish.openChange',
  openFile: 'remotish.openFile',
  stage: 'remotish.stage',
  unstage: 'remotish.unstage',
  stageAll: 'remotish.stageAll',
  unstageAll: 'remotish.unstageAll',
  revert: 'remotish.revert',
  revertAll: 'remotish.revertAll',
  refresh: 'remotish.refresh',
} as const;

/** Projects one Remotish workspace into native VS Code SCM groups, input, and publish actions. */
export class RemotishSourceControl implements vscode.Disposable {
  readonly sourceControl: vscode.SourceControl;
  private readonly changes: vscode.SourceControlResourceGroup;
  private readonly stagedChanges: vscode.SourceControlResourceGroup;
  private readonly stagedPathsByBranch = new Map<BranchName, Set<RepoPath>>();
  private readonly workspaceSubscription: CoreDisposable;
  private disposed: boolean = false;
  private refreshRequested: boolean = false;
  private refreshPromise: Promise<void> | undefined;

  constructor(
    readonly workspaceId: string,
    readonly workspace: RemotishWorkspace,
  ) {
    this.sourceControl = vscode.scm.createSourceControl(
      'remotish',
      'Remotish',
      createWorkingUri(workspaceId),
    );
    this.sourceControl.inputBox.placeholder = 'Commit message';
    this.sourceControl.quickDiffProvider = {
      provideOriginalResource: (uri) => this.originalResource(uri),
    };
    this.sourceControl.acceptInputCommand = command(
      SCM_COMMANDS.commitAndPush,
      'Commit & Push',
      workspaceId,
    );

    this.stagedChanges = this.sourceControl.createResourceGroup('staged', 'Staged Changes');
    this.stagedChanges.hideWhenEmpty = true;
    this.changes = this.sourceControl.createResourceGroup('changes', 'Changes');
    this.changes.hideWhenEmpty = false;

    this.workspaceSubscription = workspace.onDidChange(() => void this.refresh());
    this.refreshActionButton();
    void this.refresh();
  }

  /** Paths selected for the next commit on the current branch. */
  get stagedPaths(): readonly RepoPath[] {
    return [...this.currentSelection()].sort();
  }

  /** Add paths to the current branch's commit selection. */
  async stage(paths: readonly RepoPath[]): Promise<void> {
    const selection = this.currentSelection();
    for (const path of paths) {
      selection.add(path);
    }
    await this.refresh();
  }

  /** Remove paths from the current branch's commit selection. */
  async unstage(paths: readonly RepoPath[]): Promise<void> {
    const selection = this.currentSelection();
    for (const path of paths) {
      selection.delete(path);
    }
    await this.refresh();
  }

  /** Select every current working-tree change for the next commit. */
  async stageAll(): Promise<void> {
    const selection = this.currentSelection();
    for (const change of await this.workspace.getChanges()) {
      selection.add(change.path);
    }
    await this.refresh();
  }

  /** Clear the current branch's commit selection. */
  async unstageAll(): Promise<void> {
    this.currentSelection().clear();
    await this.refresh();
  }

  refresh(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }

    this.refreshRequested = true;
    if (!this.refreshPromise) {
      this.refreshPromise = this.runRefreshLoop().finally(() => {
        this.refreshPromise = undefined;
      });
    }
    return this.refreshPromise;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.refreshRequested = false;
    this.workspaceSubscription.dispose();
    this.stagedChanges.dispose();
    this.changes.dispose();
    this.sourceControl.dispose();
  }

  private async runRefreshLoop(): Promise<void> {
    while (this.refreshRequested && !this.disposed) {
      this.refreshRequested = false;
      const branch = this.workspace.branch;
      const changes = await this.workspace.getChanges();
      if (this.disposed) {
        return;
      }

      // A branch switch can complete while getChanges() is in flight. Ignore the old branch's
      // snapshot and immediately refresh the newly selected branch instead.
      if (this.workspace.branch !== branch) {
        this.refreshRequested = true;
        continue;
      }

      this.applyChanges(branch, changes);
    }
  }

  private applyChanges(branch: BranchName, changes: readonly WorkingTreeChange[]): void {
    const selection = this.selectionForBranch(branch);
    const validPaths = new Set(changes.map((change) => change.path));

    for (const path of [...selection]) {
      if (!validPaths.has(path)) {
        selection.delete(path);
      }
    }

    const staged = [];
    const unstaged = [];
    for (const change of changes) {
      const state = this.toResourceState(change);
      if (selection.has(change.path)) {
        staged.push(state);
      } else {
        unstaged.push(state);
      }
    }

    this.stagedChanges.resourceStates = staged;
    this.changes.resourceStates = unstaged;
    this.sourceControl.count = changes.length;
    this.refreshActionButton();
  }

  private currentSelection(): Set<RepoPath> {
    return this.selectionForBranch(this.workspace.branch);
  }

  private selectionForBranch(branch: BranchName): Set<RepoPath> {
    let selection = this.stagedPathsByBranch.get(branch);
    if (!selection) {
      selection = new Set<RepoPath>();
      this.stagedPathsByBranch.set(branch, selection);
    }
    return selection;
  }

  private toResourceState(change: WorkingTreeChange): vscode.SourceControlResourceState {
    const model = toScmChangeResource(change);
    const uri = createWorkingUri(this.workspaceId, model.path);
    return {
      resourceUri: uri,
      command: {
        command: SCM_COMMANDS.openChange,
        title: 'Open Diff',
        arguments: [this.workspaceId, model.path],
      },
      contextValue: `remotish.${model.type}`,
      decorations: {
        iconPath: new vscode.ThemeIcon(model.icon),
        tooltip: model.tooltip,
        strikeThrough: model.strikeThrough,
      },
    };
  }

  private async originalResource(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
    const path = resourcePath(uri);
    const revision = this.workspace.baseRevision;
    try {
      const stat = await this.workspace.statRevision(revision, path);
      if (stat.type !== 'file') {
        return undefined;
      }
      return createRevisionUri(this.workspaceId, revision, path);
    } catch (error) {
      if (error instanceof RemotishError && error.code === 'NOT_FOUND') {
        return undefined;
      }
      throw error;
    }
  }

  private refreshActionButton(): void {
    const primary = command(
      SCM_COMMANDS.commitAndPush,
      'Commit & Push',
      this.workspaceId,
      'Commit & Push',
    );
    const secondary: vscode.Command[][] = [[primary]];

    if (this.workspace.capabilities.forceWithLease) {
      secondary.push([
        command(
          SCM_COMMANDS.commitAndPushForceWithLease,
          'Commit & Push (Force with Lease)',
          this.workspaceId,
        ),
      ]);
    }

    if (this.workspace.capabilities.forceWithLease && this.workspace.capabilities.amend) {
      secondary.push([
        command(
          SCM_COMMANDS.amendAndPushForceWithLease,
          'Amend & Push (Force with Lease)',
          this.workspaceId,
        ),
      ]);
    }

    this.sourceControl.actionButton = {
      command: primary,
      secondaryCommands: secondary,
      enabled: true,
    };
  }
}

function command(
  id: string,
  title: string,
  workspaceId: string,
  shortTitle?: string,
): vscode.Command & { shortTitle?: string } {
  return {
    command: id,
    title,
    arguments: [workspaceId],
    ...(shortTitle ? { shortTitle } : {}),
  };
}

/** Resolves the current remote head for one explicitly selected branch. */
export async function currentRemoteRevision(
  workspace: RemotishWorkspace,
  branch: BranchName,
): Promise<RevisionId> {
  const branches = await workspace.listBranches();
  const remote = branches.find((candidate) => candidate.name === branch);
  if (!remote) {
    throw new RemotishError('NOT_FOUND', `Branch ${branch} no longer exists.`);
  }
  return remote.revision;
}
