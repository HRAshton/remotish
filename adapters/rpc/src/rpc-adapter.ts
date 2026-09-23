import {
  type Branch,
  type BranchName,
  type CommitChange,
  type CommitPage,
  type CommitQuery,
  type CommitRequest,
  type CommitResult,
  type DirectoryEntry,
  type RemoteRequestOptions,
  type RemotishAdapter,
  type RemotishCapabilities,
  RemotishError,
  type RepoPath,
  type RepositoryInfo,
  type RevisionId,
} from '@remotish/adapter-sdk';
import {
  decodeRpcResponse,
  decodeRpcSession,
  encodeRpcCommit,
  REMOTISH_RPC_VERSION,
  type RpcOperation,
  type RpcTransport,
} from './protocol.js';

/** Repository-semantic adapter over a caller-supplied, correlated RPC transport. */
export class RpcAdapter implements RemotishAdapter {
  readonly capabilities: RemotishCapabilities;
  readonly commit?: (
    request: CommitRequest,
    options?: RemoteRequestOptions,
  ) => Promise<CommitResult>;
  readonly createBranch?: (
    name: BranchName,
    revision: RevisionId,
    options?: RemoteRequestOptions,
  ) => Promise<Branch>;
  readonly deleteBranch?: (name: BranchName, options?: RemoteRequestOptions) => Promise<void>;

  constructor(
    private readonly transport: RpcTransport,
    session: unknown,
  ) {
    this.capabilities = decodeRpcSession(session).capabilities;
    if (this.capabilities.commits) {
      this.commit = (request, options) => {
        if (request.push.mode === 'force-with-lease' && !this.capabilities.forceWithLease) {
          return Promise.reject(
            new RemotishError('UNSUPPORTED', 'Force-with-lease is unavailable.'),
          );
        }
        if (request.type === 'amend' && !this.capabilities.amend) {
          return Promise.reject(new RemotishError('UNSUPPORTED', 'Amend is unavailable.'));
        }
        return this.call('commit', encodeRpcCommit(request), options);
      };
    }
    if (this.capabilities.createBranch) {
      this.createBranch = (name, revision, options) =>
        this.call('createBranch', { name, revision }, options);
    }
    if (this.capabilities.deleteBranch) {
      this.deleteBranch = (name, options) => this.call('deleteBranch', { name }, options);
    }
  }

  getRepository(options?: RemoteRequestOptions): Promise<RepositoryInfo> {
    return this.call('getRepository', {}, options);
  }

  async readDirectory(
    revision: RevisionId,
    path: RepoPath,
    options?: RemoteRequestOptions,
  ): Promise<readonly DirectoryEntry[]> {
    const entries = await this.call<readonly DirectoryEntry[]>(
      'readDirectory',
      { revision, path },
      options,
    );
    const prefix = path === '' ? '' : `${path}/`;
    for (const entry of entries) {
      const child = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : '';
      if (!child || child.includes('/')) {
        throw new RemotishError('UNKNOWN', 'Invalid Remotish RPC directory child.');
      }
    }
    return entries;
  }

  readFile(
    revision: RevisionId,
    path: RepoPath,
    options?: RemoteRequestOptions,
  ): Promise<Uint8Array> {
    return this.call('readFile', { revision, path }, options);
  }

  getBranches(options?: RemoteRequestOptions): Promise<readonly Branch[]> {
    return this.call('getBranches', {}, options);
  }

  getCommits(request: CommitQuery, options?: RemoteRequestOptions): Promise<CommitPage> {
    return this.call(
      'getCommits',
      {
        ...(request.branch === undefined ? {} : { branch: request.branch }),
        ...(request.revision === undefined ? {} : { revision: request.revision }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      },
      options,
    );
  }

  getCommitChanges(
    revision: RevisionId,
    options?: RemoteRequestOptions,
  ): Promise<readonly CommitChange[]> {
    return this.call('getCommitChanges', { revision }, options);
  }

  private async call<T>(
    operation: RpcOperation,
    payload: unknown,
    options?: RemoteRequestOptions,
  ): Promise<T> {
    const signal = options?.signal;
    if (signal?.aborted) {
      throw cancelled();
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      if (signal) {
        onAbort = () => reject(cancelled());
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
        }
      }
    });
    let response: unknown;
    try {
      const request = { version: REMOTISH_RPC_VERSION, operation, payload };
      response = await Promise.race([
        Promise.resolve().then(() =>
          this.transport.request(request, signal ? { signal } : undefined),
        ),
        aborted,
      ]);
    } catch {
      if (signal?.aborted) {
        throw cancelled();
      }
      throw new RemotishError('OFFLINE', 'Remotish RPC transport failed.');
    } finally {
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    }
    if (signal?.aborted) {
      throw cancelled();
    }
    return decodeRpcResponse(operation, response) as T;
  }
}

function cancelled(): RemotishError {
  return new RemotishError('CANCELLED', 'Remotish RPC request cancelled.');
}
