import type { RpcRequest } from '@remotish/adapter-rpc';
import {
  type Branch,
  type CommitChange,
  type CommitPage,
  type DirectoryEntry,
  RemotishError,
  type RepositoryInfo,
} from '@remotish/adapter-sdk';
import { BitbucketApiClient } from './api-client.js';
import {
  branchName,
  commitInfo,
  filePayload,
  malformed,
  object,
  optionalPath,
  optionalText,
  page,
  remotePath,
  remoteRevision,
  repoPath,
  revision,
  revisionPayload,
  text,
} from './codec.js';
import { BitbucketCommitService, type BitbucketSourcePublisher } from './commit-service.js';

export type {
  BitbucketSourcePublisher,
  BitbucketSourcePublishRequest,
  BitbucketSourcePublishResponse,
} from './commit-service.js';

const BITBUCKET_ORIGIN = 'https://bitbucket.org';
// Base64 plus RPC and encrypted-frame overhead must fit the 24 MiB transport frame.
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const SLUG = /^[a-z0-9][a-z0-9._-]*$/iu;

export type BitbucketTokenSource = () => string | undefined | Promise<string | undefined>;

/** Derive the sole repository claim from a Bitbucket tab, never from page globals or RPC data. */
export function createBitbucketEndpoint(
  pageUrl: string,
  token: BitbucketTokenSource,
  // Keep the isolated world's native receiver when the endpoint calls this as a member.
  fetcher: typeof fetch = fetch.bind(globalThis),
  sourcePublisher?: BitbucketSourcePublisher,
): BitbucketEndpoint | undefined {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return undefined;
  }
  if (page.origin !== BITBUCKET_ORIGIN || page.username || page.password) {
    return undefined;
  }
  const parts = page.pathname.split('/').filter(Boolean);
  const workspace = parts[0];
  const slug = parts[1];
  if (
    !workspace ||
    !slug ||
    !SLUG.test(workspace) ||
    !SLUG.test(slug) ||
    ['account', 'dashboard', 'explore', 'site', 'workspace', 'workspaces'].includes(
      workspace.toLowerCase(),
    )
  ) {
    return undefined;
  }
  return new BitbucketEndpoint(workspace, slug, token, fetcher, sourcePublisher);
}

/** Bitbucket Cloud repository semantics over official REST API V2 endpoints. */
export class BitbucketEndpoint {
  readonly target: string;
  readonly session;
  private readonly basePath: string;
  private readonly client: BitbucketApiClient;
  private readonly commits: BitbucketCommitService;

  constructor(
    workspace: string,
    slug: string,
    token: BitbucketTokenSource,
    fetcher: typeof fetch,
    sourcePublisher?: BitbucketSourcePublisher,
  ) {
    this.target = `${BITBUCKET_ORIGIN}/${workspace}/${slug}`;
    this.basePath = `/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`;
    this.client = new BitbucketApiClient(token, fetcher);
    this.commits = new BitbucketCommitService(this.basePath, this.client, sourcePublisher);
    this.session = {
      version: 1 as const,
      capabilities: {
        commits: sourcePublisher !== undefined,
        createBranch: true,
        deleteBranch: true,
      },
    };
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
        return this.commits.commit(request.payload, signal);
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
    const data = object(await this.client.getJson(this.basePath, signal), 'repository');
    const uuid = text(data.uuid, 'repository.uuid');
    if (!/^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/iu.test(uuid)) {
      throw malformed('repository.uuid');
    }
    const mainbranch = object(data.mainbranch, 'repository.mainbranch');
    const description = data.description;
    if (description !== undefined && description !== null && typeof description !== 'string') {
      throw malformed('repository.description');
    }
    return {
      id: `bitbucket-cloud:${uuid.toLowerCase()}`,
      name: text(data.name, 'repository.name'),
      defaultBranch: text(mainbranch.name, 'repository.mainbranch.name'),
      ...(typeof description === 'string' ? { description } : {}),
    };
  }

  private async getBranches(signal: AbortSignal): Promise<readonly Branch[]> {
    const repository = await this.getRepository(signal);
    const path = `${this.basePath}/refs/branches`;
    const values = await this.client.getAll(path, signal);
    return values.map((value) => {
      const data = object(value, 'branch');
      const target = object(data.target, 'branch.target');
      const name = text(data.name, 'branch.name');
      return {
        name,
        revision: remoteRevision(target.hash, 'branch.target.hash'),
        isDefault: name === repository.defaultBranch,
      };
    });
  }

  private async readDirectory(
    valueRevision: string,
    valuePath: string,
    signal: AbortSignal,
  ): Promise<readonly DirectoryEntry[]> {
    const path = repoPath(valuePath);
    const prefix = path ? `${path}/` : '';
    const values = await this.client.getAll(this.sourcePath(valueRevision, path), signal);
    return values.map((value) => {
      const data = object(value, 'directory entry');
      const entryPath = remotePath(data.path, 'entry.path');
      const name = entryPath.startsWith(prefix) ? entryPath.slice(prefix.length) : '';
      if (!name || name.includes('/')) {
        throw malformed('directory child');
      }
      if (data.type !== 'commit_file' && data.type !== 'commit_directory') {
        throw malformed('entry.type');
      }
      const size = data.size;
      if (
        size !== undefined &&
        (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
      ) {
        throw malformed('entry.size');
      }
      return {
        name,
        path: entryPath,
        type: data.type === 'commit_file' ? 'file' : 'directory',
        ...(typeof size === 'number' ? { size } : {}),
      };
    });
  }

  private async readFile(
    valueRevision: string,
    valuePath: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const path = repoPath(valuePath);
    if (!path) {
      throw new RemotishError('INVALID_REQUEST', 'A file path is required.');
    }
    const source = this.sourcePath(valueRevision, path);
    const metadata = object(
      await this.client.getJson(`${source}?format=meta`, signal),
      'file metadata',
    );
    if (metadata.type !== 'commit_file' || remotePath(metadata.path, 'file.path') !== path) {
      throw new RemotishError('NOT_FOUND', 'Bitbucket path is not a file.');
    }
    return this.client.getBytes(source, MAX_FILE_BYTES, signal);
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
    const ref =
      branch ?? (requestedRevision === undefined ? undefined : revision(requestedRevision));
    const path = `${this.basePath}/commits${ref === undefined ? '' : `/${encodeURIComponent(ref)}`}`;
    const url =
      cursor === undefined ? `${path}?pagelen=${limit}` : this.client.nextUrl(cursor, path);
    const data = page(await this.client.getJson(url, signal));
    if (data.values.length > limit) {
      throw malformed('commit page length');
    }
    return {
      commits: data.values.map(commitInfo),
      ...(data.next === undefined ? {} : { nextCursor: this.client.nextUrl(data.next, path) }),
    };
  }

  private async getCommitChanges(
    valueRevision: string,
    signal: AbortSignal,
  ): Promise<readonly CommitChange[]> {
    const path = `${this.basePath}/diffstat/${revision(valueRevision)}`;
    const values = await this.client.getAll(path, signal);
    return values.map((value) => {
      const data = object(value, 'diffstat entry');
      const oldPath = data.old === null ? undefined : optionalPath(data.old, 'old');
      const newPath = data.new === null ? undefined : optionalPath(data.new, 'new');
      switch (data.status) {
        case 'added':
          if (newPath) {
            return { type: 'added', path: newPath };
          }
          break;
        case 'removed':
          if (oldPath) {
            return { type: 'deleted', path: oldPath };
          }
          break;
        case 'modified':
          if (newPath) {
            return { type: 'modified', path: newPath };
          }
          break;
        case 'renamed':
          if (oldPath && newPath) {
            return { type: 'renamed', path: newPath, previousPath: oldPath };
          }
          break;
      }
      throw malformed('diffstat status or path');
    });
  }

  private async createBranch(name: string, target: string, signal: AbortSignal): Promise<Branch> {
    const response = await this.client.request(
      `${this.basePath}/refs/branches`,
      'POST',
      signal,
      JSON.stringify({ name, target: { hash: target } }),
      'application/json',
    );
    this.client.requireStatus(response, 201);
    const data = object(await this.client.responseJson(response, signal), 'created branch');
    const actual = object(data.target, 'created branch.target');
    if (
      data.name !== name ||
      remoteRevision(actual.hash, 'created branch.target.hash') !== target
    ) {
      throw malformed('created branch');
    }
    return { name, revision: target };
  }

  private async deleteBranch(name: string, signal: AbortSignal): Promise<null> {
    const response = await this.client.request(
      `${this.basePath}/refs/branches/${encodeURIComponent(name)}`,
      'DELETE',
      signal,
    );
    this.client.requireStatus(response, 204);
    return null;
  }

  private sourcePath(valueRevision: string, path: string): string {
    const suffix = path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : '/';
    return `${this.basePath}/src/${revision(valueRevision)}${suffix}`;
  }
}
