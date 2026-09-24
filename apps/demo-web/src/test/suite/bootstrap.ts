import * as vscode from 'vscode';
import { withBrowserRpcFixtureEndpoint } from './browser-rpc.js';

/** Runs under a real Code-OSS Web `?folder=remotish-rpc://...` launch. */
export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (
    folder?.scheme !== 'remotish-rpc' ||
    folder.authority !== 'open' ||
    folder.path !== '/v1/aHR0cHM6Ly9leGFtcGxlLmNvbS9icm93c2VyLXJwYy1zbW9rZQ' ||
    folder.query !== 'branch=ZmVhdHVyZS90ZXN0'
  ) {
    throw new Error('Code-OSS Web did not open the Browser RPC bootstrap folder URL.');
  }
  await withBrowserRpcFixtureEndpoint(async (_, repositoryRequest) => {
    const root = await vscode.workspace.fs.stat(folder);
    if (root.type !== vscode.FileType.Directory) {
      throw new Error('Browser RPC bootstrap did not expose a temporary folder root.');
    }
    await repositoryRequest;
  });
}
