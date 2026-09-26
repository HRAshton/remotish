import type { RpcRequest } from '@remotish/adapter-rpc';
import {
  type Branch,
  type CommitChange,
  type CommitPage,
  type DirectoryEntry,
  RemotishError,
  type RepositoryInfo,
} from '@remotish/adapter-sdk';
import { BitbucketDataCenterApiClient } from './api-client.js';
import {
  branchName,
  commitChange,
  commitInfo,
  encodedRepoPath,
  filePayload,
  integer,
  malformed,
  object,
  optionalText,
  page,
  pageStart,
  remoteBranchName,
  remotePath,
  remoteRevision,
  repoPath,
  revision,
  revisionPayload,
  text,
} from './codec.js';
import { type RepositoryRoute, repositoryRoute } from './route.js';

// Base64 plus RPC and encrypted-frame overhead must fit the 24 MiB transport frame.
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_LIST_ITEMS = 10_000;

export type BitbucketDataCenterTokenSource = () => string | undefined | Promise<string | undefined>;

/** Derive the sole repository claim from a Bitbucket Data Center tab. */
export function createBitbucketDataCenterEndpoint(
  pageUrl: string,
  expectedOrigin: string,
  token: BitbucketDataCenterTokenSource,
  // Keep the isolated world's native receiver when the endpoint calls this as a member.
  fetcher: typeof fetch = fetch.bind(globalThis),
): BitbucketDataCenterEndpoint | undefined {
  const route = repositoryRoute(pageUrl, expectedOrigin);
  return route === undefined ? undefined : new BitbucketDataCenterEndpoint(route, token, fetcher);
}

/** Bitbucket Data Center 9.4 repository semantics over its public REST APIs. */
export class BitbucketDataCenterEndpoint {
  readonly target: string;
  readonly session = {
    version: 1,
    capabilities: { commits: false, createBranch: true, deleteBranch: true },
  } as const;
  private readonly repositoryPath: string;
  private readonly branchPath: string;
  private readonly client: BitbucketDataCenterApiClient;

  constructor(
    private readonly route: RepositoryRoute,
    token: BitbucketDataCenterTokenSource,
    fetcher: typeof fetch,
  ) {
    this.target = route.target;
    const repository =
      `projects/${encodeURIComponent(route.projectKey)}` +
      `/repos/${encodeURIComponent(route.slug)}`;
    this.repositoryPath = `rest/api/1.0/${repository}`;
    this.branchPath = `rest/branch-utils/1.0/${repository}/branches`;
    this.client = new BitbucketDataCenterApiClient(route, token, fetcher);
  }

  async handle(request: RpcRequest, signal: AbortSignal): Promise<unknown> {
    switch (request.operation) {
      case 'getRepository':
        return this.getRepository(signal);
      case 'getBranches':
        return this.getBranches(signal);
      case 'readDirectory': {
        const payload = filePayload(request.payload);
        return this.readDirectory(payload.revision, payload.path, signal);
      }
      case 'readFile': {
        const payload = filePayload(request.payload);
        return this.readFile(payload.revision, payload.path, signal);
      }
      case 'getCommits':
        return this.getCommits(request.payload, signal);
      case 'getCommitChanges':
        return this.getCommitChanges(revisionPayload(request.payload), signal);
      case 'commit':
        return {
          status: 'rejected',
          reason: 'UNSUPPORTED',
          message:
            'Bitbucket Data Center REST does not provide atomic branch-head commit publication.',
        };
      case 'createBranch': {
        const payload = object(request.payload, 'create branch request');
        return this.createBranch(branchName(payload.name), revision(payload.revision), signal);
      }
      case 'deleteBranch':
        return this.deleteBranch(
          branchName(object(request.payload, 'delete branch request').name),
          signal,
        );
    }
  }

  private async getRepository(signal: AbortSignal): Promise<RepositoryInfo> {
    const data = object(await this.client.getJson(this.repositoryPath, signal), 'repository');
    if (data.scmId !== 'git') {
      throw new RemotishError('UNSUPPORTED', 'Only Git Bitbucket repositories are supported.');
    }
    const id = integer(data.id, 'repository.id');
    const slug = text(data.slug, 'repository.slug');
    const project = object(data.project, 'repository.project');
    const projectKey = text(project.key, 'repository.project.key');
    if (
      slug !== this.route.slug ||
      projectKey.toLowerCase() !== this.route.projectKey.toLowerCase()
    ) {
      throw malformed('repository identity');
    }
    const description = data.description;
    if (description !== undefined && description !== null && typeof description !== 'string') {
      throw malformed('repository.description');
    }
    return {
      id: `bitbucket-datacenter:${encodeURIComponent(this.route.serverBase)}:${id}`,
      name: text(data.name, 'repository.name'),
      defaultBranch: remoteBranchName(data.defaultBranch, 'repository.defaultBranch'),
      ...(typeof description === 'string' ? { description } : {}),
    };
  }

  private async getBranches(signal: AbortSignal): Promise<readonly Branch[]> {
    const repository = await this.getRepository(signal);
    const values = await this.client.getAll(
      `${this.repositoryPath}/branches`,
      new URLSearchParams(),
      signal,
    );
    return values.map((value) => {
      const data = object(value, 'branch');
      const name = remoteBranchName(data.displayId, 'branch.displayId');
      const id = text(data.id, 'branch.id');
      if (id !== `refs/heads/${name}`) {
        throw malformed('branch.id');
      }
      return {
        name,
        revision: remoteRevision(data.latestCommit, 'branch.latestCommit'),
        isDefault: name === repository.defaultBranch,
      };
    });
  }

  private async readDirectory(
    valueRevision: string,
    valuePath: string,
    signal: AbortSignal,
  ): Promise<readonly DirectoryEntry[]> {
    const currentRevision = revision(valueRevision);
    const path = repoPath(valuePath);
    const suffix = path ? `/${encodedRepoPath(path)}` : '';
    const params = new URLSearchParams({ at: currentRevision });
    const files = await this.client.getAll(`${this.repositoryPath}/files${suffix}`, params, signal);
    const prefix = path ? `${path}/` : '';
    const entries = new Map<string, DirectoryEntry>();
    for (const value of files) {
      const file = remotePath(value, 'file path');
      if (!file.startsWith(prefix)) {
        throw malformed('directory child');
      }
      const relative = file.slice(prefix.length);
      if (!relative) {
        throw malformed('directory child');
      }
      const slash = relative.indexOf('/');
      const name = slash < 0 ? relative : relative.slice(0, slash);
      const entryPath = path ? `${path}/${name}` : name;
      const type = slash < 0 ? 'file' : 'directory';
      const previous = entries.get(name);
      if (previous !== undefined && previous.type !== type) {
        throw malformed('directory child');
      }
      entries.set(name, { name, path: entryPath, type });
    }
    return [...entries.values()];
  }

  private async readFile(
    valueRevision: string,
    valuePath: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const currentRevision = revision(valueRevision);
    const path = repoPath(valuePath);
    if (!path) {
      throw new RemotishError('INVALID_REQUEST', 'A file path is required.');
    }
    const encoded = encodedRepoPath(path);
    const typeParams = new URLSearchParams({ at: currentRevision, type: 'true' });
    const metadata = object(
      await this.client.getJson(
        this.client.url(`${this.repositoryPath}/browse/${encoded}`, typeParams),
        signal,
      ),
      'file type',
    );
    if (metadata.type === 'DIRECTORY') {
      throw new RemotishError('NOT_FOUND', 'Bitbucket path is not a file.');
    }
    if (metadata.type === 'SUBMODULE') {
      throw new RemotishError(
        'UNSUPPORTED',
        'Bitbucket submodules are not ordinary file contents.',
      );
    }
    if (metadata.type !== 'FILE') {
      throw malformed('file type');
    }
    const params = new URLSearchParams({ at: currentRevision });
    return this.client.getBytes(
      `${this.repositoryPath}/raw/${encoded}`,
      params,
      MAX_FILE_BYTES,
      signal,
      'application/octet-stream, */*',
    );
  }

  private async getCommits(value: unknown, signal: AbortSignal): Promise<CommitPage> {
    const input = object(value, 'commit query');
    const branch = optionalText(input.branch, 'query.branch');
    const requestedRevision = optionalText(input.revision, 'query.revision');
    const cursor = optionalText(input.cursor, 'query.cursor');
    const limit = input.limit === undefined ? 50 : input.limit;
    if (
      (branch !== undefined && requestedRevision !== undefined) ||
      typeof limit !== 'number' ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new RemotishError('INVALID_REQUEST', 'Invalid Bitbucket commit query.');
    }
    const start = cursor === undefined ? 0 : pageStart(cursor);
    const until =
      branch === undefined
        ? requestedRevision === undefined
          ? undefined
          : revision(requestedRevision)
        : branchName(branch);
    const params = new URLSearchParams({
      limit: String(limit),
      start: String(start),
      withCounts: 'false',
      ...(until === undefined ? {} : { until }),
    });
    const data = page(
      await this.client.getJson(this.client.url(`${this.repositoryPath}/commits`, params), signal),
    );
    if (data.values.length > limit) {
      throw malformed('commit page length');
    }
    return {
      commits: data.values.map(commitInfo),
      ...(data.nextPageStart === undefined ? {} : { nextCursor: String(data.nextPageStart) }),
    };
  }

  private async getCommitChanges(
    valueRevision: string,
    signal: AbortSignal,
  ): Promise<readonly CommitChange[]> {
    const currentRevision = revision(valueRevision);
    const params = new URLSearchParams({ limit: String(MAX_LIST_ITEMS) });
    const data = page(
      await this.client.getJson(
        this.client.url(`${this.repositoryPath}/commits/${currentRevision}/changes`, params),
        signal,
      ),
    );
    // Bitbucket documents a server-side hard cap for this endpoint and no way to fetch beyond it.
    // Never return a knowingly partial change list.
    if (
      data.nextPageStart !== undefined ||
      data.values.length >= MAX_LIST_ITEMS ||
      (data.limit < MAX_LIST_ITEMS && data.values.length >= data.limit)
    ) {
      throw new RemotishError(
        'UNSUPPORTED',
        'Bitbucket commit change list exceeds the supported limit.',
      );
    }
    return data.values.map(commitChange);
  }

  private async createBranch(name: string, target: string, signal: AbortSignal): Promise<Branch> {
    const response = await this.client.request(
      this.branchPath,
      'POST',
      signal,
      JSON.stringify({ name, startPoint: target }),
      'application/json',
    );
    this.client.requireStatus(response, 201);
    const data = object(await this.client.responseJson(response, signal), 'created branch');
    const actualName = remoteBranchName(data.displayId, 'created branch.displayId');
    if (
      actualName !== name ||
      text(data.id, 'created branch.id') !== `refs/heads/${name}` ||
      remoteRevision(data.latestCommit, 'created branch.latestCommit') !== target
    ) {
      throw malformed('created branch');
    }
    return { name, revision: target };
  }

  private async deleteBranch(name: string, signal: AbortSignal): Promise<null> {
    const response = await this.client.request(
      this.branchPath,
      'DELETE',
      signal,
      JSON.stringify({ name: `refs/heads/${name}`, dryRun: false }),
      'application/json',
    );
    this.client.requireStatus(response, 204);
    return null;
  }
}
