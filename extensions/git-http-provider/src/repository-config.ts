import { validateGitUrl } from '@remotish/adapter-git-http';
import {
  REMOTISH_REPOSITORY_COMMAND_VERSION,
  RemotishError,
  type RemotishRepositoryRequest,
} from '@remotish/adapter-sdk';
import * as vscode from 'vscode';

export const PROVIDER_ID = 'git-http';
export const TOKEN_SECRET = 'remotish.gitHttp.token.v1';
export const PAIRING_SECRET = 'remotish.gitHttp.pairingKey.v1';
export const RESTORE_PREFIX = 'remotish.gitHttp.restore.v1.';
const WORKSPACE_ID = /^git-http-[0-9a-f]{32}$/u;

export interface GitHttpSettings {
  readonly url: string;
  readonly name: string;
  readonly email: string;
}

export function decodeGitRepository(repository: Readonly<Record<string, string>>): string {
  if (Object.keys(repository).sort().join(',') !== 'url' || typeof repository.url !== 'string') {
    throw new RemotishError('INVALID_REQUEST', 'Git HTTP descriptor requires only a URL.');
  }
  const url = validateGitUrl(repository.url);
  if (url !== repository.url) {
    throw new RemotishError(
      'INVALID_REQUEST',
      'Expected a canonical credential-free HTTPS Git clone URL.',
    );
  }
  return url;
}

export function readSettings(): GitHttpSettings {
  const config = vscode.workspace.getConfiguration('remotish.gitHttp');
  return {
    url: decodeGitRepository({ url: config.get<string>('url', '') }),
    name: config.get<string>('authorName', ''),
    email: config.get<string>('authorEmail', ''),
  };
}

export function restoreRepository(
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
    throw invalidRestoration();
  }
  const data = raw as Record<string, unknown>;
  if (
    Object.keys(data).sort().join(',') !== 'url,version' ||
    data.version !== 1 ||
    typeof data.url !== 'string'
  ) {
    throw invalidRestoration();
  }
  const url = decodeGitRepository({ url: data.url });
  return { provider: PROVIDER_ID, repository: { url } };
}

export function preparedWorkspaceId(raw: unknown): string {
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

function invalidRestoration(): RemotishError {
  return new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP restoration record.');
}
