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
import { type HeaderProvider, HttpClient } from './http-client.js';
import {
  decodeBranch,
  decodeBranches,
  decodeCommitChanges,
  decodeCommitPage,
  decodeCommitResult,
  decodeDirectoryEntries,
  decodeRepositoryInfo,
} from './http-json.js';
import { encodeCommitRequest } from './wire.js';

/** Connection options for the example HTTP repository protocol. */
export interface HttpRemotishAdapterOptions {
  readonly baseUrl: string;
  readonly capabilities: RemotishCapabilities;
  readonly fetch?: typeof fetch;
  readonly headers?: HeaderProvider;
  /** Request deadline in milliseconds. */
  readonly requestTimeoutMs?: number;
  /** Maximum bytes accepted for one JSON response. */
  readonly maxJsonResponseBytes?: number;
  /** Maximum bytes accepted for one file response. */
  readonly maxFileBytes?: number;
}

/**
 * Maps the example HTTP repository protocol onto the Remotish adapter contract.
 * All JSON responses are validated before being returned as SDK domain values.
 */
export class HttpRemotishAdapter implements RemotishAdapter {
  readonly capabilities: RemotishCapabilities;
  private readonly client: HttpClient;

  constructor(options: HttpRemotishAdapterOptions) {
    this.capabilities = { ...options.capabilities };
    this.client = new HttpClient(options);
  }

  getRepository(options?: RemoteRequestOptions): Promise<RepositoryInfo> {
    return this.client.json('/repository', decodeRepositoryInfo, withSignal(options));
  }

  readDirectory(
    revision: RevisionId,
    path: RepoPath,
    options?: RemoteRequestOptions,
  ): Promise<readonly DirectoryEntry[]> {
    return this.client.json(
      `/tree?${query({ revision, path })}`,
      decodeDirectoryEntries,
      withSignal(options),
    );
  }

  readFile(
    revision: RevisionId,
    path: RepoPath,
    options?: RemoteRequestOptions,
  ): Promise<Uint8Array> {
    return this.client.bytes(`/file?${query({ revision, path })}`, withSignal(options));
  }

  getBranches(options?: RemoteRequestOptions): Promise<readonly Branch[]> {
    return this.client.json('/branches', decodeBranches, withSignal(options));
  }

  getCommits(request: CommitQuery, options?: RemoteRequestOptions): Promise<CommitPage> {
    return this.client.json(
      `/commits?${query({
        branch: request.branch,
        revision: request.revision,
        cursor: request.cursor,
        limit: request.limit,
      })}`,
      decodeCommitPage,
      withSignal(options),
    );
  }

  getCommitChanges(
    revision: RevisionId,
    options?: RemoteRequestOptions,
  ): Promise<readonly CommitChange[]> {
    return this.client.json(
      `/commits/${encodeURIComponent(revision)}/changes`,
      decodeCommitChanges,
      withSignal(options),
    );
  }

  commit(request: CommitRequest, options?: RemoteRequestOptions): Promise<CommitResult> {
    return this.client.sendJson(
      '/commit',
      'POST',
      decodeCommitResult,
      encodeCommitRequest(request),
      [409, 412],
      options?.signal,
    );
  }

  async createBranch(
    name: BranchName,
    revision: RevisionId,
    options?: RemoteRequestOptions,
  ): Promise<Branch> {
    if (!this.capabilities.createBranch) {
      throw new RemotishError('UNSUPPORTED', 'Branch creation is disabled.');
    }
    return this.client.sendJson(
      '/branches',
      'POST',
      decodeBranch,
      { name, revision },
      [],
      options?.signal,
    );
  }

  async deleteBranch(name: BranchName, options?: RemoteRequestOptions): Promise<void> {
    if (!this.capabilities.deleteBranch) {
      throw new RemotishError('UNSUPPORTED', 'Branch deletion is disabled.');
    }
    await this.client.sendVoid(
      `/branches/${encodeURIComponent(name)}`,
      'DELETE',
      undefined,
      options?.signal,
    );
  }
}

function query(values: Readonly<Record<string, string | number | undefined>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  return params.toString();
}

function withSignal(options: RemoteRequestOptions | undefined): RequestInit {
  return options?.signal ? { signal: options.signal } : {};
}
