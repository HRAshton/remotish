import * as vscode from 'vscode';
import { runBrowserRpcSmoke } from './browser-rpc.js';
import { run as runWebSmoke } from './index.js';

export async function run(): Promise<void> {
  const browserRpc = vscode.extensions.getExtension('hrashton.remotish-browser-rpc-provider');
  if (!browserRpc) {
    throw new Error('Browser RPC provider extension was not loaded into Code-OSS Web.');
  }
  const marker = (browserRpc.packageJSON as Record<string, unknown>).remotish as
    | Record<string, unknown>
    | undefined;
  if (marker?.provider !== true || marker.apiVersion !== 1 || marker.id !== 'browser-rpc') {
    throw new Error('Browser RPC provider did not retain its discovery marker.');
  }
  if (browserRpc.isActive) {
    throw new Error('Browser RPC provider activated during manifest-only discovery.');
  }
  await runWebSmoke();
  await runBrowserRpcSmoke();
}
