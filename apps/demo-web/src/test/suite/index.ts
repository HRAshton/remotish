import * as vscode from 'vscode';

const encoder = new TextEncoder();

interface PreparedFixture {
  readonly workspaceId: string;
  readonly uri: string;
}

export async function run(): Promise<PreparedFixture> {
  const prepared = await vscode.commands.executeCommand<PreparedFixture>(
    'remotish.ensureRepository',
    {
      version: 1,
      provider: 'fixture-provider',
      repository: { repository: 'demo' },
    },
  );
  if (!prepared?.workspaceId || !prepared.uri.startsWith('remotish://fixture-provider-')) {
    throw new Error('Remotish did not prepare the fixture through provider discovery.');
  }

  const root = vscode.Uri.parse(prepared.uri);
  const entries = await vscode.workspace.fs.readDirectory(root);
  if (!entries.some(([name]) => name === 'README.md')) {
    throw new Error('Remotish fixture workspace did not expose README.md.');
  }

  const readme = new TextDecoder().decode(
    await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, 'README.md')),
  );
  if (!readme.includes('Fixture repository')) {
    throw new Error('Fixture provider did not create the expected repository.');
  }

  await vscode.commands.executeCommand('remotish.refresh', prepared.workspaceId);

  const smokeFile = root.with({ path: '/vsix-smoke.txt' });
  await vscode.workspace.fs.writeFile(smokeFile, encoder.encode('packaged VSIX smoke test\n'));
  const written = new TextDecoder().decode(await vscode.workspace.fs.readFile(smokeFile));
  if (written !== 'packaged VSIX smoke test\n') {
    throw new Error('Packaged extension failed virtual-filesystem write/read smoke test.');
  }
  await vscode.commands.executeCommand('remotish.stageAll', prepared.workspaceId);
  await vscode.commands.executeCommand('remotish.unstageAll', prepared.workspaceId);
  await vscode.workspace.fs.delete(smokeFile);

  return prepared;
}
