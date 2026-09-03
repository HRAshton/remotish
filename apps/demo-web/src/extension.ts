import { FixtureAdapter } from '@remotish/adapter-fixture';
import { RemotishWorkspace } from '@remotish/core';
import { createWorkingUri, RemotishVsCodeHost, StorageUriWorkspaceStorage } from '@remotish/vscode';
import { RemotishHistoryHost } from '@remotish/vscode-history';
import * as vscode from 'vscode';

const WORKSPACE_ID = 'fixture-demo';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const storage = new StorageUriWorkspaceStorage(
    context.storageUri ?? context.globalStorageUri,
    'demo-fixture',
  );

  const workspace = await RemotishWorkspace.open(new FixtureAdapter(), storage);

  const host = new RemotishVsCodeHost();
  const unregister = host.registry.register(WORKSPACE_ID, workspace);
  const history = new RemotishHistoryHost(host);

  const openFixture = vscode.commands.registerCommand('remotish.demo.openFixture', () =>
    vscode.commands.executeCommand('vscode.openFolder', createWorkingUri(WORKSPACE_ID), false),
  );

  context.subscriptions.push(host, history, unregister, openFixture);
}
