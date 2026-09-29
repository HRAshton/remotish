import { RemotishDiagnostics, RemotishProviderHost } from '@remotish/vscode';
import type * as vscode from 'vscode';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const providers = new RemotishProviderHost(context);
  const diagnostics = new RemotishDiagnostics(context, providers);
  context.subscriptions.push(providers, diagnostics);
}
