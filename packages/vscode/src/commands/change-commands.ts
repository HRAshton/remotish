import { RemotishError } from '@remotish/adapter-sdk';
import * as vscode from 'vscode';
import { createRevisionUri, createWorkingUri } from '../filesystem/provider.js';
import type { ScmManager } from '../scm/manager.js';
import { SCM_COMMANDS } from '../scm/source-control.js';
import type { WorkspaceRegistry } from '../workspaces/workspace-registry.js';
import { requireScmResourceArgument, requireScmWorkspaceId } from './resource-argument.js';
import { type CommandLogger, runCommand } from './run-command.js';

/** Registers commands that inspect, select, and revert working-tree changes. */
export function registerChangeCommands(
  registry: WorkspaceRegistry,
  scm: ScmManager,
  logger: CommandLogger,
): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand(SCM_COMMANDS.openChange, (value: unknown, path?: string) =>
      runCommand(logger, () => openChangeFromArgument(registry, value, path)),
    ),
    vscode.commands.registerCommand(SCM_COMMANDS.openFile, (value: unknown, path?: string) =>
      runCommand(logger, () => openFileFromArgument(value, path)),
    ),
    vscode.commands.registerCommand(SCM_COMMANDS.stage, (value: unknown, path?: string) =>
      runCommand(logger, () => updateSelection(scm, value, path, true)),
    ),
    vscode.commands.registerCommand(SCM_COMMANDS.unstage, (value: unknown, path?: string) =>
      runCommand(logger, () => updateSelection(scm, value, path, false)),
    ),
    vscode.commands.registerCommand(SCM_COMMANDS.stageAll, (value: unknown) =>
      runCommand(logger, () => updateAllSelection(scm, value, true)),
    ),
    vscode.commands.registerCommand(SCM_COMMANDS.unstageAll, (value: unknown) =>
      runCommand(logger, () => updateAllSelection(scm, value, false)),
    ),
    vscode.commands.registerCommand(SCM_COMMANDS.revert, (value: unknown, path?: string) =>
      runCommand(logger, () => revertFromArgument(registry, value, path)),
    ),
    vscode.commands.registerCommand(SCM_COMMANDS.revertAll, (value: unknown) =>
      runCommand(logger, () => revertAllFromArgument(registry, value)),
    ),
  );
}

async function openChangeFromArgument(
  registry: WorkspaceRegistry,
  value: unknown,
  explicitPath?: string,
): Promise<void> {
  const resource = requireScmResourceArgument(value, explicitPath);
  await openChange(registry, resource.workspaceId, resource.path);
}

async function openFileFromArgument(value: unknown, explicitPath?: string): Promise<void> {
  const resource = requireScmResourceArgument(value, explicitPath);
  await vscode.commands.executeCommand(
    'vscode.open',
    createWorkingUri(resource.workspaceId, resource.path),
  );
}

async function updateSelection(
  scm: ScmManager,
  value: unknown,
  explicitPath: string | undefined,
  selected: boolean,
): Promise<void> {
  const resource = requireScmResourceArgument(value, explicitPath);
  const sourceControl = scm.get(resource.workspaceId);
  if (!sourceControl) {
    throw new RemotishError(
      'INVALID_REQUEST',
      `Source control for ${resource.workspaceId} is unavailable.`,
    );
  }

  if (selected) {
    await sourceControl.stage([resource.path]);
  } else {
    await sourceControl.unstage([resource.path]);
  }
}

async function updateAllSelection(
  scm: ScmManager,
  value: unknown,
  selected: boolean,
): Promise<void> {
  const workspaceId = requireScmWorkspaceId(value);
  const sourceControl = scm.get(workspaceId);
  if (!sourceControl) {
    throw new RemotishError('INVALID_REQUEST', `Source control for ${workspaceId} is unavailable.`);
  }

  if (selected) {
    await sourceControl.stageAll();
  } else {
    await sourceControl.unstageAll();
  }
}

async function revertFromArgument(
  registry: WorkspaceRegistry,
  value: unknown,
  explicitPath?: string,
): Promise<void> {
  const resource = requireScmResourceArgument(value, explicitPath);
  const workspace = registry.require(resource.workspaceId).workspace;
  const expectedState = { branch: workspace.branch, baseRevision: workspace.baseRevision };
  const confirmed = await vscode.window.showWarningMessage(
    `Revert working changes to ${resource.path}?`,
    { modal: true },
    'Revert',
  );
  if (confirmed === 'Revert') {
    await workspace.revert(resource.path, expectedState);
  }
}

async function revertAllFromArgument(registry: WorkspaceRegistry, value: unknown): Promise<void> {
  const workspaceId = requireScmWorkspaceId(value);
  const workspace = registry.require(workspaceId).workspace;
  if (!workspace.hasChanges) {
    return;
  }
  const expectedState = { branch: workspace.branch, baseRevision: workspace.baseRevision };

  const confirmed = await vscode.window.showWarningMessage(
    'Revert all working changes?',
    { modal: true },
    'Revert All',
  );
  if (confirmed === 'Revert All') {
    await workspace.revertAll(expectedState);
  }
}

async function openChange(
  registry: WorkspaceRegistry,
  workspaceId: string,
  path: string,
): Promise<void> {
  const workspace = registry.require(workspaceId).workspace;
  await vscode.commands.executeCommand(
    'vscode.diff',
    createRevisionUri(workspaceId, workspace.baseRevision, path),
    createWorkingUri(workspaceId, path),
    `${path} (Working Changes)`,
  );
}
