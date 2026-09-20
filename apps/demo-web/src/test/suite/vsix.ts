import * as vscode from 'vscode';

import { run as runWebSmoke } from './index.js';

export async function run(): Promise<void> {
  await runWebSmoke();

  const providerExtension = vscode.extensions.getExtension(
    'remotish-tests.remotish-fixture-provider',
  );
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

  const prepared = await vscode.commands.executeCommand<{
    workspaceId: string;
    uri: string;
  }>('remotish.ensureRepository', {
    version: 1,
    provider: 'fixture-provider',
    repository: { repository: 'demo' },
  });
  if (!prepared?.workspaceId || !prepared.uri.startsWith('remotish://fixture-provider-')) {
    throw new Error('Packaged fixture provider was not discovered by Remotish.');
  }
  if (!providerExtension.isActive) {
    throw new Error('Packaged fixture provider was not lazily activated when requested.');
  }

  const providerReadme = vscode.Uri.parse(`${prepared.uri}README.md`);
  const providerContent = new TextDecoder().decode(
    await vscode.workspace.fs.readFile(providerReadme),
  );
  if (!providerContent.includes('Fixture repository')) {
    throw new Error('Packaged fixture provider did not create a usable Remotish workspace.');
  }
}
