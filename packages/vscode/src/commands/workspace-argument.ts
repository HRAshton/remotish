import { RemotishError } from '@remotish/adapter-sdk';
import * as vscode from 'vscode';
import type { WorkspaceRegistry } from '../workspaces/workspace-registry.js';

/** Resolves an explicit workspace id or interactively selects one for command-palette invocation. */
export async function resolveWorkspaceId(
  registry: WorkspaceRegistry,
  value?: unknown,
): Promise<string> {
  if (typeof value === 'string') {
    return registry.require(value).id;
  }

  const registrations = registry.list();
  if (registrations.length === 0) {
    throw new RemotishError('INVALID_REQUEST', 'No Remotish workspace is registered.');
  }

  const [registration] = registrations;
  if (registrations.length === 1 && registration) {
    return registration.id;
  }

  const pick = await vscode.window.showQuickPick(
    registrations.map((registration) => ({
      label: registration.workspace.repositoryInfo.name,
      description: registration.workspace.branch,
      detail: registration.id,
      workspaceId: registration.id,
    })),
    { placeHolder: 'Select a Remotish workspace' },
  );
  if (!pick) {
    throw new RemotishError('CANCELLED', 'Workspace selection cancelled.');
  }
  return pick.workspaceId;
}
