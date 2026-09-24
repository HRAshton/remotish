import * as vscode from 'vscode';
import { withBrowserRpcFixtureEndpoint } from './browser-rpc.js';

const BOOTSTRAP_PATH = '/v1/aHR0cHM6Ly9leGFtcGxlLmNvbS9icm93c2VyLXJwYy1zbW9rZQ';
const BRANCH_QUERY = 'branch=ZmVhdHVyZS90ZXN0';

/** The test runner restarts after openFolder, so the canonical folder is checked on its next run. */
export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (
    folder?.scheme === 'remotish-rpc' &&
    folder.authority === 'open' &&
    folder.path === BOOTSTRAP_PATH &&
    folder.query === BRANCH_QUERY
  ) {
    await withBrowserRpcFixtureEndpoint(async () => {
      const root = await vscode.workspace.fs.stat(folder);
      if (root.type !== vscode.FileType.Directory) {
        throw new Error('Browser RPC bootstrap did not expose a temporary folder root.');
      }
      // Navigation reloads this extension host. If it does not, the first phase must fail.
      await new Promise<void>((_, reject) => {
        setTimeout(
          () => reject(new Error('Browser RPC did not open the canonical folder.')),
          20000,
        );
      });
    });
    return;
  }
  if (
    folder?.scheme === 'remotish' &&
    /^browser-rpc-[0-9a-f]{32}$/u.test(folder.authority) &&
    folder.path === '/'
  ) {
    await withBrowserRpcFixtureEndpoint(async () => {
      // The new host must use the provider-owned record to restore this exact workspace.
      const readme = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, 'README.md'));
      if (readme.length === 0) {
        throw new Error('Canonical Browser RPC workspace could not read repository content.');
      }
    });
    return;
  }
  throw new Error('Code-OSS Web did not open the Browser RPC bootstrap or canonical folder URL.');
}
