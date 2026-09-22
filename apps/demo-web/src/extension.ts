import { RemotishProviderHost } from '@remotish/vscode';
import { RemotishHistoryHost } from '@remotish/vscode-history';
import type * as vscode from 'vscode';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const providers = new RemotishProviderHost(context);
  const history = new RemotishHistoryHost(providers.host);
  context.subscriptions.push(providers, history);
}
