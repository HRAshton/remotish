import { GitHubAdapter } from '@remotish/adapter-github';
import {
  REMOTISH_ADAPTER_PROVIDER_API_VERSION,
  type RemotishAdapterProviderV1,
} from '@remotish/adapter-sdk';
import * as vscode from 'vscode';
import {
  GITHUB_BOOTSTRAP_SCHEME,
  GitHubBootstrapFileSystem,
  restoreGitHubWorkspace,
} from './bootstrap.js';
import { decodeGitHubRepository, GITHUB_PROVIDER_ID } from './repository.js';

/** Construct the anonymous public-repository provider. */
export function createGitHubProvider(context: vscode.ExtensionContext): RemotishAdapterProviderV1 {
  return {
    apiVersion: REMOTISH_ADAPTER_PROVIDER_API_VERSION,
    id: GITHUB_PROVIDER_ID,
    displayName: 'GitHub',
    validateRepository(repository) {
      decodeGitHubRepository(repository);
    },
    createAdapter(repository) {
      const target = decodeGitHubRepository(repository);
      return new GitHubAdapter(target);
    },
    async restoreWorkspace(workspaceId) {
      return restoreGitHubWorkspace(context, workspaceId);
    },
  };
}

export function activate(context: vscode.ExtensionContext): RemotishAdapterProviderV1 {
  const bootstrap = new GitHubBootstrapFileSystem(context);
  context.subscriptions.push(
    bootstrap,
    vscode.workspace.registerFileSystemProvider(GITHUB_BOOTSTRAP_SCHEME, bootstrap, {
      isReadonly: true,
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (
        !vscode.workspace.workspaceFolders?.some(
          (folder) => folder.uri.scheme === GITHUB_BOOTSTRAP_SCHEME,
        )
      ) {
        bootstrap.cancel();
      }
    }),
  );
  return createGitHubProvider(context);
}
