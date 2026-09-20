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
  // Prepare the bundled fixture before exposing the Remotish filesystem provider. Otherwise VS Code
  // can probe the startup workspace while the provider is live but fixture-demo is not registered
  // yet, which incorrectly sends the demo workspace through provider restoration.
  const demoStorage = new StorageUriWorkspaceStorage(context.globalStorageUri, 'demo-fixture');
  const demoWorkspace = await RemotishWorkspace.open(new FixtureAdapter(), demoStorage);

  const providers = new RemotishProviderHost(context);
  const unregisterDemo = providers.host.registry.register(WORKSPACE_ID, demoWorkspace);
  const history = new RemotishHistoryHost(providers.host);

  // The fixture workspace is only the bundled demo/smoke-test workspace. Independently installed
  // providers are discovered by RemotishProviderHost and do not register during activation.
  const openFixture = vscode.commands.registerCommand('remotish.demo.openFixture', () =>
    vscode.commands.executeCommand('vscode.openFolder', createWorkingUri(WORKSPACE_ID), false),
  );

  context.subscriptions.push(providers, history, unregisterDemo, openFixture);
}
