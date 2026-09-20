import * as vscode from 'vscode';

const encoder = new TextEncoder();

export async function run(): Promise<void> {
  const root = vscode.Uri.parse('remotish://fixture-demo/');
  const entries = await vscode.workspace.fs.readDirectory(root);

  if (!entries.some(([name]: [string, vscode.FileType]) => name === 'README.md')) {
    throw new Error('Remotish fixture workspace did not expose README.md.');
  }

  await vscode.commands.executeCommand('remotish.refresh', 'fixture-demo');

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
