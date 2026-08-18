import * as vscode from 'vscode';
import { SCM_COMMANDS } from '../scm/source-control.js';
import type { WorkspaceRegistry } from '../workspaces/workspace-registry.js';
import { type CommandLogger, runCommand } from './run-command.js';
import { resolveWorkspaceId } from './workspace-argument.js';

/** Registers explicit remote-head refresh while preserving dirty pinned workspaces. */
export function registerRefreshCommand(
  registry: WorkspaceRegistry,
  logger: CommandLogger,
): vscode.Disposable {
  return vscode.commands.registerCommand(SCM_COMMANDS.refresh, (workspaceId?: unknown) =>
    runCommand(logger, async () =>
      refreshWorkspace(registry, await resolveWorkspaceId(registry, workspaceId)),
    ),
  );
}

async function refreshWorkspace(registry: WorkspaceRegistry, workspaceId: string): Promise<void> {
  const registration = registry.require(workspaceId);
  const result = await registration.workspace.refreshRemoteHead();
  if (result.status === 'updated') {
    void vscode.window.showInformationMessage(
      `Updated to remote revision ${result.remoteRevision}.`,
    );
  } else if (result.status === 'pinned') {
    void vscode.window.showWarningMessage(
      `Remote branch is now ${result.remoteRevision}; working changes remain pinned to ` +
        `${result.baseRevision}.`,
    );
  }
}
