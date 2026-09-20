import * as vscode from 'vscode';
import { type CommandLogger, runCommand } from '../commands/run-command.js';
import { resolveWorkspaceId } from '../commands/workspace-argument.js';
import type { WorkspaceRegistry } from '../workspaces/workspace-registry.js';

/** Stable command identifiers for branch switching, creation, and deletion. */
export const BRANCH_COMMANDS = {
  switchBranch: 'remotish.switchBranch',
  createBranch: 'remotish.createBranch',
  deleteBranch: 'remotish.deleteBranch',
} as const;

/** Registers branch commands backed by Remotish workspace branch semantics. */
export function registerBranchCommands(
  registry: WorkspaceRegistry,
  logger: CommandLogger,
): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand(BRANCH_COMMANDS.switchBranch, (workspaceId?: unknown) =>
      runCommand(logger, async () =>
        switchBranch(registry, await resolveWorkspaceId(registry, workspaceId)),
      ),
    ),
    vscode.commands.registerCommand(BRANCH_COMMANDS.createBranch, (workspaceId?: unknown) =>
      runCommand(logger, async () =>
        createBranch(registry, await resolveWorkspaceId(registry, workspaceId)),
      ),
    ),
    vscode.commands.registerCommand(BRANCH_COMMANDS.deleteBranch, (workspaceId?: unknown) =>
      runCommand(logger, async () =>
        deleteBranch(registry, await resolveWorkspaceId(registry, workspaceId)),
      ),
    ),
  );
}

async function switchBranch(registry: WorkspaceRegistry, workspaceId: string): Promise<void> {
  const workspace = registry.require(workspaceId).workspace;
  const branches = await workspace.listBranches();
  const pick = await vscode.window.showQuickPick(
    branches.map((branch) => ({
      label: branch.name,
      description: branch.name === workspace.branch ? 'current' : branch.revision,
      picked: branch.name === workspace.branch,
    })),
    { placeHolder: `Current branch: ${workspace.branch}` },
  );
  if (!pick || pick.label === workspace.branch) {
    return;
  }
  await workspace.switchBranch(pick.label);
}

async function createBranch(registry: WorkspaceRegistry, workspaceId: string): Promise<void> {
  const workspace = registry.require(workspaceId).workspace;
  const expectedBranch = workspace.branch;
  const expectedBaseRevision = workspace.baseRevision;
  const name = await vscode.window.showInputBox({
    title: 'Create Remote Branch',
    prompt: `Create from ${expectedBaseRevision}`,
    validateInput: (value) => (value.trim() ? undefined : 'Branch name is required.'),
  });
  if (!name) {
    return;
  }
  await workspace.createBranch(name.trim(), true, {
    branch: expectedBranch,
    baseRevision: expectedBaseRevision,
  });
}

async function deleteBranch(registry: WorkspaceRegistry, workspaceId: string): Promise<void> {
  const workspace = registry.require(workspaceId).workspace;
  const branches = (await workspace.listBranches()).filter(
    (branch) => branch.name !== workspace.branch,
  );
  const pick = await vscode.window.showQuickPick(
    branches.map((branch) => ({ label: branch.name, description: branch.revision })),
    { placeHolder: 'Select a remote branch to delete' },
  );
  if (!pick) {
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    `Delete remote branch ${pick.label}?`,
    { modal: true },
    'Delete Branch',
  );
  if (confirmed !== 'Delete Branch') {
    return;
  }
  await workspace.deleteBranch(pick.label);
}
