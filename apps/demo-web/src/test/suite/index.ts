import * as vscode from 'vscode';

const encoder = new TextEncoder();

export async function run(): Promise<void> {
  const root = vscode.Uri.parse('remotish://fixture-demo/');
  const entries = await vscode.workspace.fs.readDirectory(root);

  if (!entries.some(([name]: [string, vscode.FileType]) => name === 'README.md')) {
    throw new Error('Remotish fixture workspace did not expose README.md.');
  }

  await vscode.commands.executeCommand('remotish.refresh', 'fixture-demo');

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

  const smokeFile = root.with({ path: '/vsix-smoke.txt' });
  await vscode.workspace.fs.writeFile(smokeFile, encoder.encode('packaged VSIX smoke test\n'));
  const written = new TextDecoder().decode(await vscode.workspace.fs.readFile(smokeFile));
  if (written !== 'packaged VSIX smoke test\n') {
    throw new Error('Packaged extension failed virtual-filesystem write/read smoke test.');
  }
  await vscode.commands.executeCommand('remotish.stageAll', 'fixture-demo');
  await vscode.commands.executeCommand('remotish.unstageAll', 'fixture-demo');
  await vscode.workspace.fs.delete(smokeFile);
}
