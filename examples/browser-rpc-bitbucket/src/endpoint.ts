import type { RpcRequest } from '@remotish/adapter-rpc';
import {
  type Branch,
  type CommitChange,
  type CommitInfo,
  type CommitPage,
  type CommitRejected,
  type CommitResult,
  type DirectoryEntry,
  normalizeRepoPath,
  RemotishError,
  type RepositoryInfo,
} from '@remotish/adapter-sdk';

const BITBUCKET_ORIGIN = 'https://bitbucket.org';
const API_ORIGIN = 'https://api.bitbucket.org';
const MAX_JSON_BYTES = 2 * 1024 * 1024;
// Base64 plus RPC and encrypted-frame overhead must fit the 24 MiB transport frame.
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_COMMIT_BYTES = 16 * 1024 * 1024;
const MAX_COMMIT_CHANGES = 1000;
const MAX_PAGES = 100;
const MAX_LIST_ITEMS = 10_000;
const SHA = /^[0-9a-f]{40}$/iu;
const SLUG = /^[a-z0-9][a-z0-9._-]*$/iu;
const SOURCE_FIELDS = new Set(['branch', 'parents', 'message', 'author', 'close_branch', 'files']);

export type BitbucketTokenSource = () => string | undefined | Promise<string | undefined>;

/** Derive the sole repository claim from a Bitbucket tab, never from page globals or RPC data. */
export function createBitbucketEndpoint(
  pageUrl: string,
  token: BitbucketTokenSource,
  // Keep the isolated world's native receiver when the endpoint calls this as a member.
  fetcher: typeof fetch = fetch.bind(globalThis),
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
  return new BitbucketEndpoint(workspace, slug, token, fetcher);
}

/** Bitbucket Cloud repository semantics over official REST API V2 endpoints. */
export class BitbucketEndpoint {
  readonly target: string;
  readonly session = {
    version: 1,
    capabilities: { commits: true, createBranch: true, deleteBranch: true },
  } as const;
  private readonly basePath: string;

  constructor(
    workspace: string,
    slug: string,
    private readonly token: BitbucketTokenSource,
    private readonly fetcher: typeof fetch,
  ) {
    this.target = `${BITBUCKET_ORIGIN}/${workspace}/${slug}`;
    this.basePath = `/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`;
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
        return this.commit(request.payload, signal);
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
    const data = object(await this.getJson(this.basePath, signal), 'repository');
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
    const values = await this.getAll(path, signal);
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
    const values = await this.getAll(this.sourcePath(valueRevision, path), signal);
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
    const metadata = object(await this.getJson(`${source}?format=meta`, signal), 'file metadata');
    if (metadata.type !== 'commit_file' || remotePath(metadata.path, 'file.path') !== path) {
      throw new RemotishError('NOT_FOUND', 'Bitbucket path is not a file.');
    }
    return this.getBytes(source, MAX_FILE_BYTES, signal);
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
    const url = cursor === undefined ? `${path}?pagelen=${limit}` : this.nextUrl(cursor, path);
    const data = page(await this.getJson(url, signal));
    if (data.values.length > limit) {
      throw malformed('commit page length');
    }
    return {
      commits: data.values.map(commitInfo),
      ...(data.next === undefined ? {} : { nextCursor: this.nextUrl(data.next, path) }),
    };
  }

  private async getCommitChanges(
    valueRevision: string,
    signal: AbortSignal,
  ): Promise<readonly CommitChange[]> {
    const path = `${this.basePath}/diffstat/${revision(valueRevision)}`;
    const values = await this.getAll(path, signal);
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

  private async commit(value: unknown, signal: AbortSignal): Promise<CommitResult> {
    let prepared: CommitRejected | { form: FormData; baseRevision: string; message: string };
    try {
      prepared = this.prepareCommit(value);
    } catch {
      // Preparation is entirely local. Nothing was sent, so core can settle its journal.
      return {
        status: 'rejected',
        reason: 'UNSUPPORTED',
        message: 'Invalid Bitbucket commit request.',
      };
    }
    if ('status' in prepared) {
      return prepared;
    }
    // Bitbucket atomically asserts that parents is the current head of branch, returning 409
    // when it moved. Never retry this non-idempotent publication after an ambiguous failure.
    const response = await this.request(`${this.basePath}/src`, 'POST', signal, prepared.form);
    if (response.status === 409) {
      return { status: 'rejected', reason: 'REMOTE_CHANGED' };
    }
    this.requireStatus(response, 201);
    const publishedRevision = createdCommitRevision(response, this.basePath);
    return {
      status: 'success',
      revision: publishedRevision,
      commit: {
        revision: publishedRevision,
        parents: [prepared.baseRevision],
        message: prepared.message,
      },
    };
  }

  private prepareCommit(
    value: unknown,
  ): CommitRejected | { form: FormData; baseRevision: string; message: string } {
    const input = object(value, 'commit request');
    // These modes cannot be implemented with Bitbucket's source API without an unsafe ref rewrite.
    if (input.type !== 'commit' || object(input.push, 'commit push').mode !== 'normal') {
      return { status: 'rejected', reason: 'UNSUPPORTED' };
    }
    const branch = branchName(input.branch);
    const baseRevision = revision(input.baseRevision);
    const message = stringValue(input.message, 'commit.message');
    const changes = list(input.changes, 'commit.changes');
    if (
      !message.trim() ||
      !wellFormed(message) ||
      message.length > 10_000 ||
      !changes.length ||
      changes.length > MAX_COMMIT_CHANGES
    ) {
      return {
        status: 'rejected',
        reason: 'UNSUPPORTED',
        message: 'Bitbucket commit exceeds supported limits.',
      };
    }
    const validated: Array<
      { type: 'delete'; path: string } | { type: 'file'; path: string; content: Uint8Array }
    > = [];
    const seen = new Set<string>();
    let size = 0;
    for (const item of changes) {
      const change = object(item, 'commit change');
      const path = remotePath(change.path, 'commit change.path');
      if (
        !wellFormed(path) ||
        [...path].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      ) {
        return {
          status: 'rejected',
          reason: 'UNSUPPORTED',
          message: 'Bitbucket path cannot be represented in multipart form.',
        };
      }
      if (seen.has(path)) {
        throw new RemotishError('INVALID_REQUEST', 'Duplicate Bitbucket commit path.');
      }
      seen.add(path);
      size += path.length * 4 + 256;
      if (change.type === 'delete') {
        validated.push({ type: 'delete', path });
      } else if (change.type === 'add' || change.type === 'modify') {
        if (SOURCE_FIELDS.has(path)) {
          return {
            status: 'rejected',
            reason: 'UNSUPPORTED',
            message: 'Bitbucket cannot upload a file whose path is a source control field.',
          };
        }
        if (!(change.content instanceof Uint8Array)) {
          throw new RemotishError('INVALID_REQUEST', 'Invalid Bitbucket commit bytes.');
        }
        size += change.content.byteLength;
        validated.push({ type: 'file', path, content: change.content });
      } else {
        throw new RemotishError('INVALID_REQUEST', 'Invalid Bitbucket commit change.');
      }
      if (size > MAX_COMMIT_BYTES) {
        return {
          status: 'rejected',
          reason: 'UNSUPPORTED',
          message: 'Bitbucket commit exceeds the transport size limit.',
        };
      }
    }
    const form = new FormData();
    form.set('branch', branch);
    form.set('parents', baseRevision);
    form.set('message', message);
    for (const change of validated) {
      if (change.type === 'delete') {
        form.append('files', change.path);
      } else {
        form.append(
          change.path,
          new Blob([change.content.slice()], { type: 'application/octet-stream' }),
          change.path.split('/').at(-1),
        );
      }
    }
    return { form, baseRevision, message };
  }

  private async createBranch(name: string, target: string, signal: AbortSignal): Promise<Branch> {
    const response = await this.request(
      `${this.basePath}/refs/branches`,
      'POST',
      signal,
      JSON.stringify({ name, target: { hash: target } }),
      'application/json',
    );
    this.requireStatus(response, 201);
    const data = object(await this.responseJson(response, signal), 'created branch');
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
    const response = await this.request(
      `${this.basePath}/refs/branches/${encodeURIComponent(name)}`,
      'DELETE',
      signal,
    );
    this.requireStatus(response, 204);
    return null;
  }

  private sourcePath(valueRevision: string, path: string): string {
    const suffix = path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : '/';
    return `${this.basePath}/src/${revision(valueRevision)}${suffix}`;
  }

  private async getAll(path: string, signal: AbortSignal): Promise<readonly unknown[]> {
    const values: unknown[] = [];
    let next: string | undefined = `${path}?pagelen=100`;
    const seen = new Set<string>();
    for (let count = 0; next !== undefined && count < MAX_PAGES; count += 1) {
      const url = this.nextUrl(next, path);
      if (seen.has(url)) {
        throw malformed('pagination loop');
      }
      seen.add(url);
      const result = page(await this.getJson(url, signal));
      values.push(...result.values);
      if (values.length > MAX_LIST_ITEMS) {
        throw new RemotishError('UNSUPPORTED', 'Bitbucket listing exceeds the supported limit.');
      }
      next = result.next;
    }
    if (next !== undefined) {
      throw new RemotishError('UNSUPPORTED', 'Bitbucket listing exceeds the page limit.');
    }
    return values;
  }

  private nextUrl(value: string, path: string): string {
    let url: URL;
    try {
      url = new URL(value, API_ORIGIN);
    } catch {
      throw malformed('pagination URL');
    }
    if (
      url.origin !== API_ORIGIN ||
      url.pathname !== path ||
      url.username ||
      url.password ||
      url.hash ||
      url.href.length > 2048
    ) {
      throw malformed('pagination URL');
    }
    return url.href;
  }

  private async getJson(path: string, signal: AbortSignal): Promise<unknown> {
    const bytes = await this.getBytes(path, MAX_JSON_BYTES, signal);
    return parseJson(bytes);
  }

  private async responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
    return parseJson(await this.responseBytes(response, MAX_JSON_BYTES, signal));
  }

  private async request(
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    signal: AbortSignal,
    body?: FormData | string,
    contentType?: string,
  ): Promise<Response> {
    const credential = await this.credential();
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, API_ORIGIN), {
        method,
        headers: {
          Authorization: `Bearer ${credential}`,
          Accept: 'application/json',
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
        'Bitbucket API request failed.',
      );
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new RemotishError('UNSUPPORTED', 'Bitbucket API redirect is not supported.');
    }
    return response;
  }

  private async getBytes(path: string, limit: number, signal: AbortSignal): Promise<Uint8Array> {
    const response = await this.request(path, 'GET', signal);
    this.requireStatus(response, 200);
    return this.responseBytes(response, limit, signal);
  }

  private async credential(): Promise<string> {
    let credential: string | undefined;
    try {
      credential = await this.token();
    } catch {
      throw new RemotishError('UNAUTHORIZED', 'Bitbucket token is unavailable.');
    }
    if (
      typeof credential !== 'string' ||
      !credential ||
      credential.length > 2048 ||
      [...credential].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    ) {
      throw new RemotishError('UNAUTHORIZED', 'Configure a Bitbucket repository access token.');
    }
    return credential;
  }

  private requireStatus(response: Response, expected: number): void {
    if (response.status !== expected) {
      const code =
        response.status === 401
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
      throw new RemotishError(code, `Bitbucket API request failed (${code}).`);
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

function createdCommitRevision(response: Response, basePath: string): string {
  const location = response.headers.get('location');
  if (!location || location.length > 2048) {
    throw malformed('published commit location');
  }
  let url: URL;
  try {
    url = new URL(location, API_ORIGIN);
  } catch {
    throw malformed('published commit location');
  }
  const prefix = `${basePath}/commit/`;
  if (
    url.origin !== API_ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(prefix)
  ) {
    throw malformed('published commit location');
  }
  const value = url.pathname.slice(prefix.length);
  if (!SHA.test(value) || url.pathname !== `${prefix}${value}`) {
    throw malformed('published commit location');
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

function optionalPath(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return remotePath(object(value, label).path, `${label}.path`);
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
    remoteRevision(object(parent, 'parent').hash, 'commit parent.hash'),
  );
  const author = data.author === undefined ? undefined : object(data.author, 'commit.author');
  const rawAuthor = author === undefined ? undefined : optionalText(author.raw, 'author.raw');
  const date = optionalText(data.date, 'commit.date');
  if (
    date !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(date) ||
      Number.isNaN(Date.parse(date)))
  ) {
    throw malformed('commit.date');
  }
  return {
    revision: remoteRevision(data.hash, 'commit.hash'),
    parents,
    message: stringValue(data.message, 'commit.message'),
    ...(rawAuthor ? { author: { name: rawAuthor } } : {}),
    ...(date ? { authoredAt: date } : {}),
  };
}

function page(value: unknown): { values: readonly unknown[]; next?: string } {
  const data = object(value, 'page');
  const next = data.next === null ? undefined : optionalText(data.next, 'page.next');
  return { values: list(data.values, 'page.values'), ...(next ? { next } : {}) };
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

function malformed(label: string): RemotishError {
  return new RemotishError('UNKNOWN', `Invalid Bitbucket ${label}.`);
}
