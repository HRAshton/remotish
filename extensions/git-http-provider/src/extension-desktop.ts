import type { RemotishAdapterProviderV1 } from '@remotish/adapter-sdk';
import { createFsFromVolume, Volume } from 'memfs';
import type * as vscode from 'vscode';
import { desktopGitRequest } from './desktop-http.js';
import { activateProvider } from './extension.js';

export function activate(context: vscode.ExtensionContext): RemotishAdapterProviderV1 {
  return activateProvider(context, {
    request: desktopGitRequest,
    fs: () => createFsFromVolume(new Volume()),
  });
}
