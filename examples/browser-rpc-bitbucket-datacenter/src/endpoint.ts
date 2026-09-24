import type { RpcRequest } from '@remotish/adapter-rpc';
import {
  type Branch,
  type CommitChange,
  type CommitInfo,
  type CommitPage,
  type DirectoryEntry,
  normalizeRepoPath,
  RemotishError,
  type RepositoryInfo,
} from '@remotish/adapter-sdk';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
// Base64 plus RPC and encrypted-frame overhead must fit the 24 MiB transport frame.
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PAGES = 100;
const MAX_LIST_ITEMS = 10_000;
const SHA = /^[0-9a-f]{40}$/iu;

export type BitbucketDataCenterTokenSource = () => string | undefined | Promise<string | undefined>;

interface RepositoryRoute {
  readonly serverBase: string;
  readonly projectKey: string;
  readonly slug: string;
  readonly target: string;
}

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

  constructor(
    private readonly route: RepositoryRoute,
    private readonly token: BitbucketDataCenterTokenSource,
    private readonly fetcher: typeof fetch,
  ) {
    this.target = route.target;
    const repository =
      `projects/${encodeURIComponent(route.projectKey)}` +
      `/repos/${encodeURIComponent(route.slug)}`;
    this.repositoryPath = `rest/api/1.0/${repository}`;
    this.branchPath = `rest/branch-utils/1.0/${repository}/branches`;
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
    const data = object(await this.getJson(this.repositoryPath, signal), 'repository');
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
    const values = await this.getAll(
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
    const files = await this.getAll(`${this.repositoryPath}/files${suffix}`, params, signal);
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
      await this.getJson(this.url(`${this.repositoryPath}/browse/${encoded}`, typeParams), signal),
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
    return this.getBytes(
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
      await this.getJson(this.url(`${this.repositoryPath}/commits`, params), signal),
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
      await this.getJson(
        this.url(`${this.repositoryPath}/commits/${currentRevision}/changes`, params),
        signal,
      ),
    );
    // Bitbucket documents a server-side hard cap for this endpoint and no way to fetch beyond it.
    // Never return a knowingly partial change list.
    if (data.nextPageStart !== undefined || data.values.length >= MAX_LIST_ITEMS) {
      throw new RemotishError(
        'UNSUPPORTED',
        'Bitbucket commit change list exceeds the supported limit.',
      );
    }
    return data.values.map(commitChange);
  }

  private async createBranch(name: string, target: string, signal: AbortSignal): Promise<Branch> {
    const response = await this.request(
      this.branchPath,
      'POST',
      signal,
      JSON.stringify({ name, startPoint: target }),
      'application/json',
    );
    this.requireStatus(response, 201);
    const data = object(await this.responseJson(response, signal), 'created branch');
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
    const response = await this.request(
      this.branchPath,
      'DELETE',
      signal,
      JSON.stringify({ name: `refs/heads/${name}`, dryRun: false }),
      'application/json',
    );
    this.requireStatus(response, 204);
    return null;
  }

  private async getAll(
    path: string,
    initial: URLSearchParams,
    signal: AbortSignal,
  ): Promise<readonly unknown[]> {
    const values: unknown[] = [];
    const seen = new Set<number>();
    let start = 0;
    for (let count = 0; count < MAX_PAGES; count += 1) {
      if (seen.has(start)) {
        throw malformed('pagination loop');
      }
      seen.add(start);
      const params = new URLSearchParams(initial);
      params.set('limit', '100');
      params.set('start', String(start));
      const result = page(await this.getJson(this.url(path, params), signal));
      values.push(...result.values);
      if (values.length > MAX_LIST_ITEMS) {
        throw new RemotishError('UNSUPPORTED', 'Bitbucket listing exceeds the supported limit.');
      }
      if (result.nextPageStart === undefined) {
        return values;
      }
      start = result.nextPageStart;
    }
    throw new RemotishError('UNSUPPORTED', 'Bitbucket listing exceeds the page limit.');
  }

  private url(path: string, params?: URLSearchParams): string {
    const url = new URL(path, this.route.serverBase);
    if (params !== undefined) {
      url.search = params.toString();
    }
    return url.href;
  }

  private async getJson(pathOrUrl: string, signal: AbortSignal): Promise<unknown> {
    const bytes = await this.getBytes(
      pathOrUrl,
      undefined,
      MAX_JSON_BYTES,
      signal,
      'application/json',
    );
    return parseJson(bytes);
  }

  private async responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
    return parseJson(await this.responseBytes(response, MAX_JSON_BYTES, signal));
  }

  private async request(
    pathOrUrl: string,
    method: 'GET' | 'POST' | 'DELETE',
    signal: AbortSignal,
    body?: string,
    contentType?: string,
    accept = 'application/json',
  ): Promise<Response> {
    const credential = await this.credential();
    const url = new URL(pathOrUrl, this.route.serverBase);
    if (!url.href.startsWith(this.route.serverBase)) {
      throw new RemotishError(
        'INVALID_REQUEST',
        'Bitbucket request escaped the configured server.',
      );
    }
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: {
          Authorization: `Bearer ${credential}`,
          Accept: accept,
          ...(contentType ? { 'Content-Type': contentType } : {}),
        },
        ...(body === undefined ? {} : { body }),
        credentials: 'omit',
        redirect: 'manual',
        signal,
      });
    } catch {
      throw new RemotishError(
        signal.aborted ? 'CANCELLED' : 'OFFLINE',
        'Bitbucket Data Center API request failed.',
      );
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new RemotishError(
        'UNSUPPORTED',
        'Bitbucket Data Center API redirect is not supported.',
      );
    }
    return response;
  }

  private async getBytes(
    pathOrUrl: string,
    params: URLSearchParams | undefined,
    limit: number,
    signal: AbortSignal,
    accept: string,
  ): Promise<Uint8Array> {
    const target = params === undefined ? pathOrUrl : this.url(pathOrUrl, params);
    const response = await this.request(target, 'GET', signal, undefined, undefined, accept);
    this.requireStatus(response, 200);
    return this.responseBytes(response, limit, signal);
  }

  private async credential(): Promise<string> {
    let credential: string | undefined;
    try {
      credential = await this.token();
    } catch {
      throw new RemotishError('UNAUTHORIZED', 'Bitbucket Data Center token is unavailable.');
    }
    if (
      typeof credential !== 'string' ||
      !credential ||
      credential.length > 4096 ||
      [...credential].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    ) {
      throw new RemotishError('UNAUTHORIZED', 'Configure a Bitbucket Data Center access token.');
    }
    return credential;
  }

  private requireStatus(response: Response, expected: number): void {
    if (response.status !== expected) {
      const code =
        response.status === 400 || response.status === 409
          ? 'INVALID_REQUEST'
          : response.status === 401
            ? 'UNAUTHORIZED'
            : response.status === 403
              ? 'FORBIDDEN'
              : response.status === 404
                ? 'NOT_FOUND'
                : response.status === 429
                  ? 'RATE_LIMITED'
                  : response.status >= 500
                    ? 'OFFLINE'
                    : 'UNKNOWN';
      throw new RemotishError(code, `Bitbucket Data Center API request failed (${code}).`);
    }
  }

  private async responseBytes(
    response: Response,
    limit: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) > limit) {
      throw new RemotishError('UNSUPPORTED', 'Bitbucket response exceeds the supported size.');
    }
    const reader = response.body?.getReader();
    if (!reader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > limit) {
        throw new RemotishError('UNSUPPORTED', 'Bitbucket response exceeds the supported size.');
      }
      return bytes;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) {
          break;
        }
        size += part.value.length;
        if (size > limit) {
          await reader.cancel();
          throw new RemotishError('UNSUPPORTED', 'Bitbucket response exceeds the supported size.');
        }
        chunks.push(part.value);
      }
    } catch (error) {
      if (error instanceof RemotishError) {
        throw error;
      }
      throw new RemotishError(
        signal.aborted ? 'CANCELLED' : 'OFFLINE',
        'Bitbucket response stream failed.',
      );
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
}

function repositoryRoute(value: string, expectedOrigin: string): RepositoryRoute | undefined {
  let page: URL;
  try {
    page = new URL(value);
  } catch {
    return undefined;
  }
  let configuredOrigin: URL;
  try {
    configuredOrigin = new URL(expectedOrigin);
  } catch {
    return undefined;
  }
  if (
    page.username ||
    page.password ||
    !supportedProtocol(page) ||
    configuredOrigin.origin !== expectedOrigin ||
    configuredOrigin.username ||
    configuredOrigin.password ||
    !supportedProtocol(configuredOrigin) ||
    page.origin !== configuredOrigin.origin
  ) {
    return undefined;
  }
  const raw = page.pathname.split('/').filter(Boolean);
  const decoded: string[] = [];
  try {
    for (const part of raw) {
      const result = decodeURIComponent(part);
      if (!safeSegment(result)) {
        return undefined;
      }
      decoded.push(result);
    }
  } catch {
    return undefined;
  }
  const matches: {
    marker: number;
    projectKey: string;
    slug: string;
    personal: boolean;
  }[] = [];
  for (let index = 0; index + 3 < decoded.length; index += 1) {
    const kind = decoded[index]?.toLowerCase();
    const owner = decoded[index + 1];
    const slug = decoded[index + 3];
    if (
      (kind === 'projects' || kind === 'users') &&
      decoded[index + 2]?.toLowerCase() === 'repos' &&
      owner !== undefined &&
      slug !== undefined
    ) {
      matches.push({
        marker: index,
        projectKey: kind === 'users' ? `~${owner}` : owner,
        slug,
        personal: kind === 'users',
      });
    }
  }
  const match = matches[0];
  if (match === undefined || matches.length !== 1) {
    return undefined;
  }
  const context = raw.slice(0, match.marker).join('/');
  const serverBase = `${page.origin}/${context ? `${context}/` : ''}`;
  const routeKind = match.personal ? 'users' : 'projects';
  const routeOwner = match.personal ? match.projectKey.slice(1) : match.projectKey;
  const target =
    `${serverBase}${routeKind}/${encodeURIComponent(routeOwner)}` +
    `/repos/${encodeURIComponent(match.slug)}`;
  return { serverBase, projectKey: match.projectKey, slug: match.slug, target };
}

function supportedProtocol(url: URL): boolean {
  if (url.protocol === 'https:') {
    return true;
  }
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  );
}

function safeSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    wellFormed(value) &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}

function filePayload(value: unknown): { revision: string; path: string } {
  const data = object(value, 'file request');
  if (typeof data.path !== 'string') {
    throw malformed('path');
  }
  return { revision: revision(data.revision), path: repoPath(data.path) };
}

function revisionPayload(value: unknown): string {
  return revision(object(value, 'revision request').revision);
}

function revision(value: unknown): string {
  const result = text(value, 'revision');
  if (!SHA.test(result)) {
    throw new RemotishError('INVALID_REQUEST', 'A full commit hash is required.');
  }
  return result.toLowerCase();
}

function remoteRevision(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA.test(value)) {
    throw malformed(label);
  }
  return value.toLowerCase();
}

function branchName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 255 ||
    value === '@' ||
    value.startsWith('-') ||
    value.includes('..') ||
    value.includes('@{') ||
    value.includes('//') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    /[~^:?*\\]/u.test(value) ||
    value.includes('[') ||
    [...value].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    ) ||
    value.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))
  ) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Bitbucket branch name.');
  }
  if (!wellFormed(value)) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Bitbucket branch name.');
  }
  return value;
}

function remoteBranchName(value: unknown, label: string): string {
  try {
    return branchName(value);
  } catch {
    throw malformed(label);
  }
}

function pageStart(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Bitbucket page cursor.');
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Bitbucket page cursor.');
  }
  return result;
}

function wellFormed(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw malformed('JSON response');
  }
}

function repoPath(value: string): string {
  try {
    if (normalizeRepoPath(value) === value) {
      return value;
    }
  } catch {
    // Report the same generic path error for every malformed form.
  }
  throw new RemotishError('INVALID_REQUEST', 'Invalid Bitbucket repository path.');
}

function encodedRepoPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function remotePath(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw malformed(label);
  }
  try {
    if (normalizeRepoPath(value) === value && value) {
      return value;
    }
  } catch {
    // A malformed remote path is an invalid response, not a caller error.
  }
  throw malformed(label);
}

function commitInfo(value: unknown): CommitInfo {
  const data = object(value, 'commit');
  const parents = list(data.parents, 'commit.parents').map((parent) =>
    remoteRevision(object(parent, 'parent').id, 'commit parent.id'),
  );
  const author = data.author === undefined ? undefined : object(data.author, 'commit.author');
  const authorName = author === undefined ? undefined : optionalText(author.name, 'author.name');
  const timestamp = optionalInteger(data.authorTimestamp, 'commit.authorTimestamp');
  let authoredAt: string | undefined;
  if (timestamp !== undefined) {
    try {
      authoredAt = new Date(timestamp).toISOString();
    } catch {
      throw malformed('commit.authorTimestamp');
    }
  }
  return {
    revision: remoteRevision(data.id, 'commit.id'),
    parents,
    message: stringValue(data.message, 'commit.message'),
    ...(authorName ? { author: { name: authorName } } : {}),
    ...(authoredAt ? { authoredAt } : {}),
  };
}

function commitChange(value: unknown): CommitChange {
  const data = object(value, 'commit change');
  const path = changePath(data.path, 'change.path');
  switch (data.type) {
    case 'ADD':
    case 'COPY':
      return { type: 'added', path };
    case 'DELETE':
      return { type: 'deleted', path };
    case 'MODIFY':
      return { type: 'modified', path };
    case 'MOVE':
      return {
        type: 'renamed',
        path,
        previousPath: changePath(data.srcPath, 'change.srcPath'),
      };
    default:
      throw malformed('change.type');
  }
}

function changePath(value: unknown, label: string): string {
  const data = object(value, label);
  return remotePath(data.toString, `${label}.toString`);
}

function page(value: unknown): { values: readonly unknown[]; nextPageStart?: number } {
  const data = object(value, 'page');
  const values = list(data.values, 'page.values');
  if (typeof data.isLastPage !== 'boolean') {
    throw malformed('page.isLastPage');
  }
  if (data.isLastPage) {
    return { values };
  }
  const nextPageStart = integer(data.nextPageStart, 'page.nextPageStart');
  return { values, nextPageStart };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw malformed(label);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw malformed(label);
  }
  return value;
}

function text(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (!result) {
    throw malformed(label);
  }
  return result;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw malformed(label);
  }
  return value;
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label);
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw malformed(label);
  }
  return value;
}

function optionalInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : integer(value, label);
}

function malformed(label: string): RemotishError {
  return new RemotishError('UNKNOWN', `Invalid Bitbucket Data Center ${label}.`);
}
