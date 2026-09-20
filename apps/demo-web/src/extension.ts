import { FixtureAdapter } from '@remotish/adapter-fixture';
import { RemotishWorkspace } from '@remotish/core';
import {
  createWorkingUri,
  RemotishProviderHost,
  StorageUriWorkspaceStorage,
} from '@remotish/vscode';
import { RemotishHistoryHost } from '@remotish/vscode-history';
import * as vscode from 'vscode';

const WORKSPACE_ID = 'fixture-demo';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const providers = new RemotishProviderHost(context);
  const history = new RemotishHistoryHost(providers.host);

  // The fixture workspace is only the bundled demo/smoke-test workspace. Independently installed
  // providers are discovered by RemotishProviderHost and do not register during activation.
  const demoStorage = new StorageUriWorkspaceStorage(context.globalStorageUri, 'demo-fixture');
  const demoWorkspace = await RemotishWorkspace.open(new FixtureAdapter(), demoStorage);
  const unregisterDemo = providers.host.registry.register(WORKSPACE_ID, demoWorkspace);
  const openFixture = vscode.commands.registerCommand('remotish.demo.openFixture', () =>
    vscode.commands.executeCommand('vscode.openFolder', createWorkingUri(WORKSPACE_ID), false),
  );

  context.subscriptions.push(providers, history, unregisterDemo, openFixture);
}
