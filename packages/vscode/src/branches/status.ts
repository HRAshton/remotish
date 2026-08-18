import type { Disposable as CoreDisposable, RemotishWorkspace } from '@remotish/core';
import * as vscode from 'vscode';
import { BRANCH_COMMANDS } from './commands.js';

/** Owns the status-bar branch indicator and branch-selection QuickPick for one workspace. */
export class BranchStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly workspaceSubscription: CoreDisposable;

  constructor(
    workspaceId: string,
    private readonly workspace: RemotishWorkspace,
  ) {
    this.item.command = {
      command: BRANCH_COMMANDS.switchBranch,
      title: 'Switch Remotish Branch',
      arguments: [workspaceId],
    };
    this.workspaceSubscription = workspace.onDidChange(() => this.refresh());
    this.refresh();
    this.item.show();
  }

  dispose(): void {
    this.workspaceSubscription.dispose();
    this.item.dispose();
  }

  private refresh(): void {
    this.item.text = `$(git-branch) ${this.workspace.branch}`;
    this.item.tooltip = `${this.workspace.repositoryInfo.name} - ${this.workspace.baseRevision}`;
  }
}
