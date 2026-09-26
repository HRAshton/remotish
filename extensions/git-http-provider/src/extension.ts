import {
  GitHttpAdapter,
  type GitHttpAdapterOptions,
  GitHttpNotDispatchedError,
  type GitHttpRequest,
  type GitHttpResponse,
} from '@remotish/adapter-git-http';
import {
  REMOTISH_ADAPTER_PROVIDER_API_VERSION,
  REMOTISH_ENSURE_REPOSITORY_COMMAND,
  REMOTISH_REPOSITORY_COMMAND_VERSION,
  type RemotishAdapterProviderV1,
  RemotishError,
} from '@remotish/adapter-sdk';
import * as vscode from 'vscode';
import { GitHttpBridgeManager } from './bridge-manager.js';
import {
  decodeGitRepository,
  PAIRING_SECRET,
  PROVIDER_ID,
  preparedWorkspaceId,
  RESTORE_PREFIX,
  readSettings,
  restoreRepository,
  TOKEN_SECRET,
} from './repository-config.js';

export { decodeGitRepository } from './repository-config.js';

interface DesktopServices {
  readonly request: (
    url: string,
    token: string,
    request: GitHttpRequest,
  ) => Promise<GitHttpResponse>;
  readonly fs: () => NonNullable<GitHttpAdapterOptions['fs']>;
}

export function activateProvider(
  context: vscode.ExtensionContext,
  desktop?: DesktopServices,
): RemotishAdapterProviderV1 {
  const bridges = new GitHttpBridgeManager(context);
  const provider: RemotishAdapterProviderV1 = {
    apiVersion: REMOTISH_ADAPTER_PROVIDER_API_VERSION,
    id: PROVIDER_ID,
    displayName: 'Git HTTP',
    validateRepository(repository) {
      decodeGitRepository(repository);
    },
    async createAdapter(repository) {
      const url = decodeGitRepository(repository);
      const configured = readSettings();
      if (url !== configured.url) {
        throw new RemotishError('FORBIDDEN', 'Git repository differs from the configured origin.');
      }
      const request = await createRequest(context, bridges, url, desktop);
      return new GitHttpAdapter({
        url,
        author: { name: configured.name, email: configured.email },
        request,
        ...(desktop && vscode.env.uiKind !== vscode.UIKind.Web ? { fs: desktop.fs() } : {}),
      });
    },
    async restoreWorkspace(workspaceId) {
      return restoreRepository(context, workspaceId);
    },
  };

  context.subscriptions.push(
    registerConfigureCommand(context, bridges),
    registerOpenCommand(context),
    bridges,
  );
  return provider;
}

export function activate(context: vscode.ExtensionContext): RemotishAdapterProviderV1 {
  return activateProvider(context);
}

async function createRequest(
  context: vscode.ExtensionContext,
  bridges: GitHttpBridgeManager,
  url: string,
  desktop?: DesktopServices,
): Promise<(value: GitHttpRequest) => Promise<GitHttpResponse>> {
  if (vscode.env.uiKind === vscode.UIKind.Web) {
    await bridges.get(url);
    return async (value) => (await bridges.get(url)).request(value);
  }
  if (!desktop) {
    throw new RemotishError('UNSUPPORTED', 'Git HTTP desktop entry point is unavailable.');
  }
  if (!(await context.secrets.get(TOKEN_SECRET))) {
    throw new RemotishError('UNAUTHORIZED', 'Configure the Git HTTP bearer token.');
  }
  return async (value) => {
    if (readSettings().url !== url) {
      throw configurationChanged();
    }
    const token = await context.secrets.get(TOKEN_SECRET);
    if (!token) {
      throw new GitHttpNotDispatchedError('UNAUTHORIZED', 'Configure the Git HTTP bearer token.');
    }
    if (readSettings().url !== url) {
      throw configurationChanged();
    }
    return desktop.request(url, token, value);
  };
}

function registerConfigureCommand(
  context: vscode.ExtensionContext,
  bridges: GitHttpBridgeManager,
): vscode.Disposable {
  return vscode.commands.registerCommand('remotish.gitHttp.configure', async () => {
    const config = vscode.workspace.getConfiguration('remotish.gitHttp');
    const urlInput = await vscode.window.showInputBox({
      prompt: 'HTTPS Git clone URL',
      value: config.get('url', ''),
    });
    if (urlInput === undefined) {
      return;
    }
    const url = decodeGitRepository({ url: urlInput });

    const name = await vscode.window.showInputBox({
      prompt: 'Git author name',
      value: config.get('authorName', ''),
    });
    if (name === undefined) {
      return;
    }
    const email = await vscode.window.showInputBox({
      prompt: 'Git author email',
      value: config.get('authorEmail', ''),
    });
    if (email === undefined) {
      return;
    }
    const secret = await vscode.window.showInputBox({
      prompt:
        vscode.env.uiKind === vscode.UIKind.Web
          ? 'Bridge pairing key (43 base64url characters)'
          : 'Git HTTP bearer token',
      password: true,
      ignoreFocusOut: true,
    });
    if (secret === undefined) {
      return;
    }
    validateSecret(secret);

    await config.update('url', url, vscode.ConfigurationTarget.Global);
    await config.update('authorName', name, vscode.ConfigurationTarget.Global);
    await config.update('authorEmail', email, vscode.ConfigurationTarget.Global);
    await context.secrets.store(
      vscode.env.uiKind === vscode.UIKind.Web ? PAIRING_SECRET : TOKEN_SECRET,
      secret,
    );
    bridges.invalidate();
  });
}

function registerOpenCommand(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.commands.registerCommand('remotish.gitHttp.open', async () => {
    const { url } = readSettings();
    const result = await vscode.commands.executeCommand<unknown>(
      REMOTISH_ENSURE_REPOSITORY_COMMAND,
      {
        version: REMOTISH_REPOSITORY_COMMAND_VERSION,
        provider: PROVIDER_ID,
        repository: { url },
      },
    );
    const workspaceId = preparedWorkspaceId(result);
    await context.globalState.update(`${RESTORE_PREFIX}${workspaceId}`, { version: 1, url });
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.from({ scheme: 'remotish', authority: workspaceId, path: '/' }),
      false,
    );
  });
}

function validateSecret(secret: string): void {
  if (!secret || /[\r\n]/u.test(secret)) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP secret.');
  }
  if (vscode.env.uiKind === vscode.UIKind.Web && !/^[A-Za-z0-9_-]{43}$/u.test(secret)) {
    throw new RemotishError('INVALID_REQUEST', 'Expected a 256-bit base64url pairing key.');
  }
}

function configurationChanged(): GitHttpNotDispatchedError {
  return new GitHttpNotDispatchedError('FORBIDDEN', 'Git repository configuration changed.');
}
