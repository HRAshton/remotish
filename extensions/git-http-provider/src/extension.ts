import {
  GitHttpAdapter,
  type GitHttpAdapterOptions,
  type GitHttpRequest,
  type GitHttpResponse,
} from '@remotish/adapter-git-http';
import {
  REMOTISH_ADAPTER_PROVIDER_API_VERSION,
  REMOTISH_ENSURE_REPOSITORY_COMMAND,
  REMOTISH_REPOSITORY_COMMAND_VERSION,
  type RemotishAdapterProviderV1,
  RemotishError,
  type RemotishRepositoryRequest,
} from '@remotish/adapter-sdk';
import * as vscode from 'vscode';
import { GitHttpWebBridge } from './web-bridge.js';

const PROVIDER_ID = 'git-http';
const TOKEN_SECRET = 'remotish.gitHttp.token.v1';
const PAIRING_SECRET = 'remotish.gitHttp.pairingKey.v1';
const RESTORE_PREFIX = 'remotish.gitHttp.restore.v1.';
const WORKSPACE_ID = /^git-http-[0-9a-f]{32}$/u;

export function decodeGitRepository(repository: Readonly<Record<string, string>>): string {
  if (Object.keys(repository).sort().join(',') !== 'url' || typeof repository.url !== 'string') {
    throw new RemotishError('INVALID_REQUEST', 'Git HTTP descriptor requires only a URL.');
  }
  let url: URL;
  try {
    url = new URL(repository.url);
  } catch {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTPS URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith('.git') ||
    url.pathname.includes('//') ||
    url.pathname.split('/').some((part) => part === '.' || part === '..') ||
    url.href !== repository.url
  ) {
    throw new RemotishError(
      'INVALID_REQUEST',
      'Expected a canonical credential-free HTTPS Git clone URL.',
    );
  }
  return url.href;
}

function settings(): { readonly url: string; readonly name: string; readonly email: string } {
  const config = vscode.workspace.getConfiguration('remotish.gitHttp');
  const raw = config.get<string>('url', '');
  const url = decodeGitRepository({ url: raw });
  return {
    url,
    name: config.get<string>('authorName', ''),
    email: config.get<string>('authorEmail', ''),
  };
}

function restore(
  context: vscode.ExtensionContext,
  workspaceId: string,
): RemotishRepositoryRequest | undefined {
  if (!WORKSPACE_ID.test(workspaceId)) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP workspace ID.');
  }
  const raw = context.globalState.get<unknown>(`${RESTORE_PREFIX}${workspaceId}`);
  if (raw === undefined) {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP restoration record.');
  }
  const data = raw as Record<string, unknown>;
  if (
    Object.keys(data).sort().join(',') !== 'url,version' ||
    data.version !== 1 ||
    typeof data.url !== 'string'
  ) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP restoration record.');
  }
  const url = decodeGitRepository({ url: data.url });
  return { provider: PROVIDER_ID, repository: { url } };
}

function preparedWorkspaceId(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RemotishError('UNKNOWN', 'Invalid Remotish repository result.');
  }
  const result = raw as Record<string, unknown>;
  if (
    result.version !== REMOTISH_REPOSITORY_COMMAND_VERSION ||
    typeof result.workspaceId !== 'string' ||
    !WORKSPACE_ID.test(result.workspaceId) ||
    result.uri !== `remotish://${result.workspaceId}/`
  ) {
    throw new RemotishError('UNKNOWN', 'Invalid Remotish repository result.');
  }
  return result.workspaceId;
}

export function activateProvider(
  context: vscode.ExtensionContext,
  desktop?: {
    readonly request: (
      url: string,
      token: string,
      request: GitHttpRequest,
    ) => Promise<GitHttpResponse>;
    readonly fs: () => NonNullable<GitHttpAdapterOptions['fs']>;
  },
): RemotishAdapterProviderV1 {
  let bridge: GitHttpWebBridge | undefined;
  const provider: RemotishAdapterProviderV1 = {
    apiVersion: REMOTISH_ADAPTER_PROVIDER_API_VERSION,
    id: PROVIDER_ID,
    displayName: 'Git HTTP',
    validateRepository(repository) {
      decodeGitRepository(repository);
    },
    async createAdapter(repository) {
      const url = decodeGitRepository(repository);
      const configured = settings();
      if (url !== configured.url) {
        throw new RemotishError('FORBIDDEN', 'Git repository differs from the configured origin.');
      }
      let request: (value: GitHttpRequest) => Promise<GitHttpResponse>;
      if (vscode.env.uiKind === vscode.UIKind.Web) {
        const pairing = await context.secrets.get(PAIRING_SECRET);
        if (!pairing) {
          throw new RemotishError('UNAUTHORIZED', 'Configure the Git HTTP bridge pairing key.');
        }
        const webBridge = bridge ?? (await GitHttpWebBridge.connect(pairing, url));
        bridge = webBridge;
        request = (value) => webBridge.request(value);
      } else {
        if (!desktop) {
          throw new RemotishError('UNSUPPORTED', 'Git HTTP desktop entry point is unavailable.');
        }
        const token = await context.secrets.get(TOKEN_SECRET);
        if (!token) {
          throw new RemotishError('UNAUTHORIZED', 'Configure the Git HTTP bearer token.');
        }
        request = (value) => desktop.request(url, token, value);
      }
      return new GitHttpAdapter({
        url,
        author: { name: configured.name, email: configured.email },
        request,
        ...(desktop && vscode.env.uiKind !== vscode.UIKind.Web ? { fs: desktop.fs() } : {}),
      });
    },
    async restoreWorkspace(workspaceId) {
      return restore(context, workspaceId);
    },
  };

  const configure = vscode.commands.registerCommand('remotish.gitHttp.configure', async () => {
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
    if (!secret || /[\r\n]/u.test(secret)) {
      throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP secret.');
    }
    if (vscode.env.uiKind === vscode.UIKind.Web && !/^[A-Za-z0-9_-]{43}$/u.test(secret)) {
      throw new RemotishError('INVALID_REQUEST', 'Expected a 256-bit base64url pairing key.');
    }
    await config.update('url', url, vscode.ConfigurationTarget.Global);
    await config.update('authorName', name, vscode.ConfigurationTarget.Global);
    await config.update('authorEmail', email, vscode.ConfigurationTarget.Global);
    await context.secrets.store(
      vscode.env.uiKind === vscode.UIKind.Web ? PAIRING_SECRET : TOKEN_SECRET,
      secret,
    );
    bridge?.dispose();
    bridge = undefined;
  });
  const open = vscode.commands.registerCommand('remotish.gitHttp.open', async () => {
    const { url } = settings();
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
  context.subscriptions.push(configure, open, {
    dispose() {
      bridge?.dispose();
    },
  });
  return provider;
}

export function activate(context: vscode.ExtensionContext): RemotishAdapterProviderV1 {
  return activateProvider(context);
}
