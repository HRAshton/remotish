import * as vscode from 'vscode';
import type { ScmManager } from '../scm/manager.js';
import type { WorkspaceRegistry } from '../workspaces/workspace-registry.js';
import { registerChangeCommands } from './change-commands.js';
import { registerCommitCommands } from './commit-commands.js';
import { registerRefreshCommand } from './refresh-command.js';
import type { CommandLogger } from './run-command.js';

/** Registers the complete Remotish SCM command set for a VS Code extension context. */
export function registerScmCommands(
  registry: WorkspaceRegistry,
  scm: ScmManager,
  logger: CommandLogger,
): vscode.Disposable {
  return vscode.Disposable.from(
    registerCommitCommands(registry, scm, logger),
    registerChangeCommands(registry, scm, logger),
    registerRefreshCommand(registry, logger),
  );
}
