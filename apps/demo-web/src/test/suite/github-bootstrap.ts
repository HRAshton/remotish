import * as vscode from 'vscode';

const BOOTSTRAP_PATH = '/v1/octocat/Hello-World';

/** The test runner restarts after openFolder, so the canonical folder is checked on its next run. */
export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (
    folder?.scheme === 'remotish-github' &&
    folder.authority === 'open' &&
    folder.path === BOOTSTRAP_PATH &&
    folder.query === ''
  ) {
    const root = await vscode.workspace.fs.stat(folder);
    if (root.type !== vscode.FileType.Directory) {
      throw new Error('GitHub bootstrap did not expose a temporary folder root.');
    }
    await new Promise<void>((_, reject) => {
      setTimeout(
        () => reject(new Error('GitHub provider did not open the canonical folder.')),
        30000,
      );
    });
    return;
  }

  if (
    folder?.scheme === 'remotish' &&
    /^github-[0-9a-f]{32}$/u.test(folder.authority) &&
    folder.path === '/'
  ) {
    const readmeUri = vscode.Uri.joinPath(folder, 'README');
    const readme = new TextDecoder().decode(await vscode.workspace.fs.readFile(readmeUri));
    if (!readme.includes('Hello World!')) {
      throw new Error('Canonical GitHub workspace did not read the public fixture.');
    }

    const scratch = vscode.Uri.joinPath(folder, '.remotish-github-smoke-local.txt');
    await vscode.workspace.fs.writeFile(scratch, new TextEncoder().encode('local overlay\n'));
    const written = new TextDecoder().decode(await vscode.workspace.fs.readFile(scratch));
    if (written !== 'local overlay\n') {
      throw new Error('GitHub workspace did not preserve a local edit.');
    }
    await vscode.workspace.fs.delete(scratch);
    return;
  }

  throw new Error('Code-OSS Web did not open the GitHub bootstrap or canonical folder URL.');
}
