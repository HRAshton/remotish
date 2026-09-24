import {
  REMOTISH_ENSURE_REPOSITORY_COMMAND,
  REMOTISH_REPOSITORY_COMMAND_VERSION,
  RemotishError,
  type RemotishRepositoryRequest,
} from '@remotish/adapter-sdk';
import * as vscode from 'vscode';
import {
  type BrowserRpcBootstrapRequest,
  createBrowserRpcBootstrapUri,
  decodeBrowserRpcBootstrapUri,
} from './bootstrap-uri.js';
import { normalizeBrowserRpcTarget } from './target.js';

const RESTORE_PREFIX = 'remotish.browserRpc.restore.v1.';
const WORKSPACE_ID = /^browser-rpc-[0-9a-f]{32}$/u;
const PROVIDER_ID = 'browser-rpc';

interface RestoreRecordV1 {
  readonly version: 1;
  readonly target: string;
}

/** The temporary folder is only a rendezvous point; it contains no repository files. */
export class BrowserRpcBootstrapFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private readonly output = vscode.window.createOutputChannel('Browser RPC bootstrap', {
    log: true,
  });
  readonly onDidChangeFile = this.changes.event;
  private readonly attempts = new Map<string, Promise<void>>();
  private disposed: boolean = false;
  private generation = 0;

  constructor(private readonly context: vscode.ExtensionContext) {}

  watch(_uri: vscode.Uri): vscode.Disposable {
    return { dispose() {} };
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    if (isBootstrapChild(uri)) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    this.prepare(uri);
    return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    if (isBootstrapChild(uri)) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    this.prepare(uri);
    return [];
  }

  readFile(uri: vscode.Uri): Uint8Array {
    throw vscode.FileSystemError.FileNotFound(uri);
  }

  writeFile(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
    this.changes.dispose();
    this.output.dispose();
  }

  /** Leaving the temporary folder must not navigate back when a late endpoint appears. */
  cancel(): void {
    this.generation += 1;
    this.attempts.clear();
  }

  private prepare(uri: vscode.Uri): void {
    const request = decodeBrowserRpcBootstrapUri(uri);
    const key = createBrowserRpcBootstrapUri(request);
    if (this.disposed) {
      throw new RemotishError('OFFLINE', 'Browser RPC bootstrap is closed.');
    }
    if (this.attempts.has(key)) {
      return;
    }
    if (this.attempts.size >= 32) {
      throw new RemotishError('RATE_LIMITED', 'Too many Browser RPC bootstrap requests.');
    }
    // Folder queries must return promptly so Code-OSS can show the temporary root while the
    // endpoint is absent. The observed task retains one preparation/navigation per identity.
    const generation = this.generation;
    const attempt = this.prepareAndNavigate(request, generation).catch((error: unknown) => {
      // Keep a failed attempt settled until the folder is reopened or pairing changes. Code-OSS
      // probes the same root repeatedly, and those probes must not repeat preparation/navigation.
      if (!this.disposed && this.generation === generation) {
        const code = error instanceof RemotishError ? error.code : 'UNKNOWN';
        const message = `Browser RPC bootstrap failed (${code}). Reopen the link to retry.`;
        this.output.error(message);
        void vscode.window.showErrorMessage(message).then(
          () => undefined,
          () => this.output.error('Could not show Browser RPC bootstrap failure.'),
        );
      }
    });
    this.attempts.set(key, attempt);
  }

  private async prepareAndNavigate(
    request: BrowserRpcBootstrapRequest,
    generation: number,
  ): Promise<void> {
    const result = await vscode.commands.executeCommand<unknown>(
      REMOTISH_ENSURE_REPOSITORY_COMMAND,
      {
        version: REMOTISH_REPOSITORY_COMMAND_VERSION,
        provider: PROVIDER_ID,
        repository: { target: request.target },
        ...(request.branch === undefined ? {} : { branch: request.branch }),
      },
    );
    const workspaceId = decodePreparedWorkspaceId(result);
    if (this.disposed || this.generation !== generation) {
      return;
    }
    // The provider-owned record must be durable before openFolder can restart the extension host.
    await this.context.globalState.update(`${RESTORE_PREFIX}${workspaceId}`, {
      version: 1,
      target: request.target,
    } satisfies RestoreRecordV1);
    if (this.disposed || this.generation !== generation) {
      return;
    }
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.from({ scheme: 'remotish', authority: workspaceId, path: '/' }),
      false,
    );
  }
}

/** Restore only repository identity; the host recovers the core-owned selected branch. */
export function restoreBrowserRpcWorkspace(
  context: vscode.ExtensionContext,
  workspaceId: string,
): RemotishRepositoryRequest | undefined {
  if (!WORKSPACE_ID.test(workspaceId)) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Browser RPC workspace ID.');
  }
  const value = context.globalState.get<unknown>(`${RESTORE_PREFIX}${workspaceId}`);
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRecord();
  }
  const data = value as Record<string, unknown>;
  const keys = Object.keys(data).sort();
  if (keys.length !== 2 || keys[0] !== 'target' || keys[1] !== 'version' || data.version !== 1) {
    throw invalidRecord();
  }
  const target = normalizeBrowserRpcTarget(data.target);
  if (target !== data.target) {
    throw invalidRecord();
  }
  return { provider: PROVIDER_ID, repository: { target } };
}

function decodePreparedWorkspaceId(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidResult();
  }
  const data = value as Record<string, unknown>;
  if (
    data.version !== REMOTISH_REPOSITORY_COMMAND_VERSION ||
    typeof data.workspaceId !== 'string' ||
    !WORKSPACE_ID.test(data.workspaceId) ||
    data.uri !== `remotish://${data.workspaceId}/`
  ) {
    throw invalidResult();
  }
  return data.workspaceId;
}

function invalidRecord(): RemotishError {
  return new RemotishError('INVALID_REQUEST', 'Invalid Browser RPC restoration record.');
}

function invalidResult(): RemotishError {
  return new RemotishError('INVALID_REQUEST', 'Invalid Remotish repository preparation result.');
}

function isBootstrapChild(uri: vscode.Uri): boolean {
  return (
    uri.scheme === 'remotish-rpc' &&
    uri.authority === 'open' &&
    /^\/v1\/[A-Za-z0-9_-]+\//u.test(uri.path)
  );
}
