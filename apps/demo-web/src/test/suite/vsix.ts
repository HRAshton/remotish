import * as vscode from 'vscode';

import { run as runWebSmoke } from './index.js';

export async function run(): Promise<void> {
  const providerExtension = vscode.extensions.getExtension('hrashton.remotish-fixture-provider');
  if (!providerExtension) {
    throw new Error('Packaged fixture provider VSIX was not loaded into Code-OSS Web.');
  }
  const marker = (providerExtension.packageJSON as Record<string, unknown>).remotish as
    | Record<string, unknown>
    | undefined;
  if (marker?.provider !== true || marker.apiVersion !== 1 || marker.id !== 'fixture-provider') {
    throw new Error('Packaged fixture provider did not retain its Remotish discovery marker.');
  }
  if (providerExtension.isActive) {
    throw new Error('Packaged fixture provider activated before it was requested.');
  }

  const prepared = await runWebSmoke();
  if (!providerExtension.isActive) {
    throw new Error('Packaged fixture provider was not lazily activated when requested.');
  }
  if (!prepared.uri.startsWith('remotish://fixture-provider-')) {
    throw new Error('Packaged fixture provider did not produce a canonical Remotish workspace.');
  }
}
