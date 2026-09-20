import { type CommitResult, RemotishError } from '@remotish/adapter-sdk';
import * as vscode from 'vscode';
import type { ScmManager } from '../scm/manager.js';
import { currentRemoteRevision, SCM_COMMANDS } from '../scm/source-control.js';
import type { WorkspaceRegistry } from '../workspaces/workspace-registry.js';
import { type CommandLogger, runCommand } from './run-command.js';
import { resolveWorkspaceId } from './workspace-argument.js';

/** Registers normal, force-with-lease, and amend commit-and-publish commands. */
export function registerCommitCommands(
  registry: WorkspaceRegistry,
  scm: ScmManager,
  logger: CommandLogger,
): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand(SCM_COMMANDS.commitAndPush, (workspaceId?: unknown) =>
      runCommand(logger, async () =>
        commitAndPush(registry, scm, await resolveWorkspaceId(registry, workspaceId)),
      ),
    ),
    vscode.commands.registerCommand(
      SCM_COMMANDS.commitAndPushForceWithLease,
      (workspaceId?: unknown) =>
        runCommand(logger, async () =>
          commitAndPushForceWithLease(
            registry,
            scm,
            await resolveWorkspaceId(registry, workspaceId),
          ),
        ),
    ),
    vscode.commands.registerCommand(
      SCM_COMMANDS.amendAndPushForceWithLease,
      (workspaceId?: unknown) =>
        runCommand(logger, async () =>
          amendAndPushForceWithLease(
            registry,
            scm,
            await resolveWorkspaceId(registry, workspaceId),
          ),
        ),
    ),
  );
}

async function commitAndPush(
  registry: WorkspaceRegistry,
  scm: ScmManager,
  workspaceId: string,
): Promise<void> {
  const { workspace, input, stagedPaths } = requireScm(registry, scm, workspaceId);
  requireStagedChanges(stagedPaths);
  const message = requireMessage(input.value);
  const expectedBranch = workspace.branch;
  const expectedBaseRevision = workspace.baseRevision;
  const result = await workspace.commitAndPush(message, stagedPaths, {
    branch: expectedBranch,
    baseRevision: expectedBaseRevision,
  });
  handleCommitResult(result, input);
}

async function commitAndPushForceWithLease(
  registry: WorkspaceRegistry,
  scm: ScmManager,
  workspaceId: string,
): Promise<void> {
  const { workspace, input, stagedPaths } = requireScm(registry, scm, workspaceId);
  requireStagedChanges(stagedPaths);
  const message = requireMessage(input.value);
  const expectedBranch = workspace.branch;
  const expectedBaseRevision = workspace.baseRevision;
  const expectedRevision = await currentRemoteRevision(workspace, expectedBranch);
  const confirmed = await vscode.window.showWarningMessage(
    `Force push ${expectedBranch} with lease?`,
    {
      modal: true,
      detail: `The branch will be replaced only if its remote head is still ${expectedRevision}.`,
    },
    'Force Push',
  );
  if (confirmed !== 'Force Push') {
    return;
  }
  handleCommitResult(
    await workspace.commitAndPushForceWithLease(message, expectedRevision, stagedPaths, {
      branch: expectedBranch,
      baseRevision: expectedBaseRevision,
    }),
    input,
  );
}

async function amendAndPushForceWithLease(
  registry: WorkspaceRegistry,
  scm: ScmManager,
  workspaceId: string,
): Promise<void> {
  const { workspace, input, stagedPaths } = requireScm(registry, scm, workspaceId);
  const expectedBranch = workspace.branch;
  const expectedBaseRevision = workspace.baseRevision;
  const message = input.value.trim() || (await baseCommitMessage(workspace, expectedBaseRevision));
  const confirmed = await vscode.window.showWarningMessage(
    `Amend ${expectedBranch} and force push with lease?`,
    {
      modal: true,
      detail: `This rewrites remote commit ${expectedBaseRevision} only if the branch still points to it.`,
    },
    'Amend & Push',
  );
  if (confirmed !== 'Amend & Push') {
    return;
  }
  handleCommitResult(
    await workspace.amendAndPushForceWithLease(message, stagedPaths, {
      branch: expectedBranch,
      baseRevision: expectedBaseRevision,
    }),
    input,
  );
}

function requireScm(registry: WorkspaceRegistry, scm: ScmManager, workspaceId: string) {
  const workspace = registry.require(workspaceId).workspace;
  const entry = scm.get(workspaceId);
  const sourceControl = entry?.sourceControl;
  if (!sourceControl || !entry) {
    throw new RemotishError('UNSUPPORTED', `Source control for ${workspaceId} is unavailable.`);
  }
  return { workspace, input: sourceControl.inputBox, stagedPaths: entry.stagedPaths };
}

function requireStagedChanges(paths: readonly string[]): void {
  if (paths.length === 0) {
    throw new RemotishError('INVALID_REQUEST', 'Stage at least one change before committing.');
  }
}

function requireMessage(value: string): string {
  const message = value.trim();
  if (!message) {
    throw new RemotishError('INVALID_REQUEST', 'Commit message is required.');
  }
  return message;
}

async function baseCommitMessage(
  workspace: ReturnType<WorkspaceRegistry['require']>['workspace'],
  revision: string,
): Promise<string> {
  const page = await workspace.getCommits({ revision, limit: 1 });
  const commit =
    page.commits.find((candidate) => candidate.revision === revision) ?? page.commits[0];
  if (!commit) {
    throw new RemotishError('NOT_FOUND', `Commit ${revision} could not be loaded.`);
  }
  return commit.message;
}

function handleCommitResult(result: CommitResult, input: vscode.SourceControlInputBox): void {
  if (result.status === 'success') {
    input.value = '';
    void vscode.window.showInformationMessage(`Published ${result.revision}.`);
    return;
  }
  const suffix = result.remoteRevision ? ` Remote head: ${result.remoteRevision}.` : '';
  void vscode.window.showWarningMessage(`${result.message ?? result.reason}.${suffix}`);
}
