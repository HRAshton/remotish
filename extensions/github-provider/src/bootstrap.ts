import {
  REMOTISH_ENSURE_REPOSITORY_COMMAND,
  REMOTISH_REPOSITORY_COMMAND_VERSION,
  RemotishError,
  type RemotishRepositoryRequest,
} from '@remotish/adapter-sdk';
import * as vscode from 'vscode';
import {
  decodeGitHubRepository,
  GITHUB_PROVIDER_ID,
  type GitHubRepositoryDescriptor,
} from './repository.js';

export const GITHUB_BOOTSTRAP_SCHEME = 'remotish-github';

const RESTORE_PREFIX = 'remotish.github.restore.v1.';
const WORKSPACE_ID = /^github-[0-9a-f]{32}$/u;

interface RestoreRecordV1 extends GitHubRepositoryDescriptor {
  readonly version: 1;
}

/** Create the temporary Code-OSS folder URI for one public GitHub repository. */
export function createGitHubBootstrapUri(repository: GitHubRepositoryDescriptor): string {
  const decoded = decodeGitHubRepository(repository);
  return `${GITHUB_BOOTSTRAP_SCHEME}://open/v1/${decoded.owner}/${decoded.repository}`;
}

/** Decode the only versioned GitHub bootstrap form accepted by the provider. */
export function decodeGitHubBootstrapUri(value: unknown): GitHubRepositoryDescriptor {
  const uri = decodeUriParts(value);
  if (
    uri.scheme !== GITHUB_BOOTSTRAP_SCHEME ||
    uri.authority !== 'open' ||
    uri.query !== '' ||
    uri.fragment !== ''
  ) {
    throw invalidBootstrap();
  }
  const prefix = '/v1/';
  if (!uri.path.startsWith(prefix)) {
    throw invalidBootstrap();
  }
  const segments = uri.path.slice(prefix.length).split('/');
  if (segments.length !== 2) {
    throw invalidBootstrap();
  }
  const owner = decodeDirectSegment(segments[0] ?? '');
  const repository = decodeDirectSegment(segments[1] ?? '');
  return decodeGitHubRepository({ owner, repository });
}

/** The temporary root contains no repository files; it only prepares and redirects. */
export class GitHubBootstrapFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private readonly output = vscode.window.createOutputChannel('GitHub bootstrap', { log: true });
  readonly onDidChangeFile = this.changes.event;
  private readonly attempts = new Map<string, Promise<void>>();
  private finalizationTail: Promise<void> = Promise.resolve();
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

  /** Leaving the temporary folder prevents a late preparation from navigating back to it. */
  cancel(): void {
    this.generation += 1;
    this.attempts.clear();
  }

  private prepare(uri: vscode.Uri): void {
    const repository = decodeGitHubBootstrapUri(uri);
    const key = createGitHubBootstrapUri(repository);
    if (this.disposed) {
      throw new RemotishError('OFFLINE', 'GitHub bootstrap is closed.');
    }
    if (this.attempts.has(key)) {
      return;
    }
    if (this.attempts.size >= 32) {
      throw new RemotishError('RATE_LIMITED', 'Too many GitHub bootstrap requests.');
    }

    const generation = this.generation;
    const attempt = this.prepareAndNavigate(repository, generation).catch((error: unknown) => {
      if (!this.disposed && this.generation === generation) {
        const code = error instanceof RemotishError ? error.code : 'UNKNOWN';
        const message = `GitHub bootstrap failed (${code}). Reopen the link to retry.`;
        this.output.error(message);
        void vscode.window.showErrorMessage(message).then(
          () => undefined,
          () => this.output.error('Could not show GitHub bootstrap failure.'),
        );
      }
    });
    this.attempts.set(key, attempt);
  }

  private async prepareAndNavigate(
    repository: GitHubRepositoryDescriptor,
    generation: number,
  ): Promise<void> {
    const result = await vscode.commands.executeCommand<unknown>(
      REMOTISH_ENSURE_REPOSITORY_COMMAND,
      {
        version: REMOTISH_REPOSITORY_COMMAND_VERSION,
        provider: GITHUB_PROVIDER_ID,
        repository,
      },
    );
    const workspaceId = decodePreparedWorkspaceId(result);

    const finalize = this.finalizationTail.then(async () => {
      if (this.disposed || this.generation !== generation) {
        return;
      }
      await this.context.globalState.update(`${RESTORE_PREFIX}${workspaceId}`, {
        version: 1,
        ...repository,
      } satisfies RestoreRecordV1);
      if (this.disposed || this.generation !== generation) {
        return;
      }
      await vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.from({ scheme: 'remotish', authority: workspaceId, path: '/' }),
        false,
      );
    });
    this.finalizationTail = finalize.then(
      () => undefined,
      () => undefined,
    );
    await finalize;
  }
}

/** Restore repository identity only; branch and local overlay remain core-owned state. */
export function restoreGitHubWorkspace(
  context: vscode.ExtensionContext,
  workspaceId: string,
): RemotishRepositoryRequest | undefined {
  if (!WORKSPACE_ID.test(workspaceId)) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid GitHub workspace ID.');
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
  if (
    keys.length !== 3 ||
    keys[0] !== 'owner' ||
    keys[1] !== 'repository' ||
    keys[2] !== 'version' ||
    data.version !== 1
  ) {
    throw invalidRecord();
  }

  let repository: GitHubRepositoryDescriptor;
  try {
    repository = decodeGitHubRepository({
      owner: data.owner,
      repository: data.repository,
    });
  } catch {
    throw invalidRecord();
  }
  return {
    provider: GITHUB_PROVIDER_ID,
    repository: {
      owner: repository.owner,
      repository: repository.repository,
    },
  };
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

function decodeDirectSegment(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw invalidBootstrap();
  }
  if (decoded !== value) {
    throw invalidBootstrap();
  }
  return decoded;
}

interface BootstrapUriParts {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
}

function decodeUriParts(value: unknown): BootstrapUriParts {
  if (typeof value === 'string') {
    if (value.length > 4096) {
      throw invalidBootstrap();
    }
    let uri: URL;
    try {
      uri = new URL(value);
    } catch {
      throw invalidBootstrap();
    }
    if (uri.username || uri.password) {
      throw invalidBootstrap();
    }
    return {
      scheme: uri.protocol.slice(0, -1),
      authority: uri.host,
      path: uri.pathname,
      query: uri.search.slice(1),
      fragment: uri.hash.slice(1),
    };
  }
  if (!value || typeof value !== 'object') {
    throw invalidBootstrap();
  }
  const parts = value as Record<string, unknown>;
  if (
    typeof parts.scheme !== 'string' ||
    typeof parts.authority !== 'string' ||
    typeof parts.path !== 'string' ||
    typeof parts.query !== 'string' ||
    typeof parts.fragment !== 'string' ||
    parts.path.length + parts.query.length > 4096
  ) {
    throw invalidBootstrap();
  }
  return {
    scheme: parts.scheme,
    authority: parts.authority,
    path: parts.path,
    query: parts.query,
    fragment: parts.fragment,
  };
}

function invalidBootstrap(): RemotishError {
  return new RemotishError('INVALID_REQUEST', 'Invalid GitHub bootstrap URI.');
}

function invalidRecord(): RemotishError {
  return new RemotishError('INVALID_REQUEST', 'Invalid GitHub restoration record.');
}

function invalidResult(): RemotishError {
  return new RemotishError('INVALID_REQUEST', 'Invalid Remotish repository preparation result.');
}

function isBootstrapChild(uri: vscode.Uri): boolean {
  return (
    uri.scheme === GITHUB_BOOTSTRAP_SCHEME &&
    uri.authority === 'open' &&
    /^\/v1\/[^/]+\/[^/]+\//u.test(uri.path)
  );
}
