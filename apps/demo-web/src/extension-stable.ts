import { RemotishProviderHost } from '@remotish/vscode';
import type * as vscode from 'vscode';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(new RemotishProviderHost(context));
}
