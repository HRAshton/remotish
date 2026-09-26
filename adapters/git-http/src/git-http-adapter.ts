import LightningFS, { MemoryBackend } from '@isomorphic-git/lightning-fs';
import {
  type Branch,
  type BranchName,
  type CommitChange,
  type CommitInfo,
  type CommitPage,
  type CommitQuery,
  type CommitRequest,
  type CommitResult,
  type DirectoryEntry,
  normalizeRepoPath,
  type RemoteRequestOptions,
  type RemotishAdapter,
  RemotishError,
  type RepoPath,
  type RepositoryInfo,
  type RevisionId,
} from '@remotish/adapter-sdk';
import * as git from 'isomorphic-git';
import {
  createGitHttpClient,
  type GitHttpAdapterOptions,
  GitHttpNotDispatchedError,
  normalizeGitHttpError,
  validateGitUrl,
} from './transport.js';

const DIR = '/repository';
const ZERO_OID = '0'.repeat(40);
const MAX_HISTORY = 10_000;
const MAX_BRANCHES = 10_000;
const MAX_TREE_ENTRIES = 100_000;
const SHA = /^[0-9a-f]{40}$/u;

interface FileEntry {
  readonly oid: string;
  readonly mode: string;
}

function revision(value: string): string {
  if (!SHA.test(value)) {
    throw new RemotishError('INVALID_REQUEST', 'Expected a full Git commit SHA.');
  }
  return value;
}

function branch(value: string): string {
  if (
    !value ||
    value === '@' ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.startsWith('.') ||
    value.endsWith('.') ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    value.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock')) ||
    [...value].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    ) ||
    /[~^:?*]/u.test(value) ||
    value.includes('[') ||
    value.includes('\\')
  ) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git branch name.');
  }
  return value;
}

function safePath(value: string): string {
  const path = normalizeRepoPath(value);
  if (value !== path || path.startsWith('.git/') || path === '.git') {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git repository path.');
  }
  return path;
}

function info(oid: string, commit: git.CommitObject): CommitInfo {
  return {
    revision: oid,
    parents: commit.parent,
    message: commit.message,
    author: { name: commit.author.name, email: commit.author.email },
    authoredAt: new Date(commit.author.timestamp * 1000).toISOString(),
  };
}

function isDefiniteRefRejection(error: unknown, ref: string): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const gitError = error as Record<string, unknown>;
  if (gitError.code !== 'GitPushError' || !gitError.data || typeof gitError.data !== 'object') {
    return false;
  }
  const data = gitError.data as Record<string, unknown>;
  if (!data.result || typeof data.result !== 'object') {
    return false;
  }
  const result = data.result as Record<string, unknown>;
  if (!result.refs || typeof result.refs !== 'object') {
    return false;
  }
  const status = (result.refs as Record<string, unknown>)[ref];
  return !!status && typeof status === 'object' && (status as Record<string, unknown>).ok === false;
}

/** Git objects, refs and pack files live only in this adapter's in-memory filesystem. */
export class GitHttpAdapter implements RemotishAdapter {
  readonly capabilities = {
    commits: true,
    forceWithLease: true,
    amend: true,
    createBranch: true,
    deleteBranch: true,
  } as const;

  private readonly fs: git.PromiseFsClient;
  private readonly url: string;
  private initialized: Promise<void> | undefined;
  private refreshing: Promise<void> | undefined;
  private defaultBranch?: string;

  constructor(private readonly options: GitHttpAdapterOptions) {
    this.fs = options.fs ?? new LightningFS(crypto.randomUUID(), { db: new MemoryBackend() });
    this.url = validateGitUrl(options.url);
    if (!options.author.name.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(options.author.email)) {
      throw new RemotishError('INVALID_REQUEST', 'Configure a Git author name and email.');
    }
  }

  private http(signal?: AbortSignal, onReceivePackRequest?: () => void): git.HttpClient {
    return createGitHttpClient(this.options, signal, onReceivePackRequest);
  }

  private async ready(signal?: AbortSignal): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        await this.fs.promises.mkdir(DIR);
        await git.init({ fs: this.fs, dir: DIR });
        await git.addRemote({ fs: this.fs, dir: DIR, remote: 'origin', url: this.url });
      })();
    }
    await this.initialized;
    if (!this.defaultBranch) {
      await this.refresh(signal);
    }
  }

  private async refresh(signal?: AbortSignal): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        this.check(signal);
        const result = await git
          .fetch({
            fs: this.fs,
            http: this.http(signal),
            dir: DIR,
            url: this.url,
            remote: 'origin',
            singleBranch: false,
            tags: false,
            prune: true,
          })
          .catch((error: unknown) => {
            throw normalizeGitHttpError(error);
          });
        if (!result.defaultBranch) {
          throw new RemotishError('UNSUPPORTED', 'Git remote has no default branch.');
        }
        this.defaultBranch = branch(result.defaultBranch.replace(/^refs\/heads\//u, ''));
      })();
    }
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }

  private check(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new RemotishError('CANCELLED', 'Git operation cancelled.');
    }
  }

  private async commitObject(oid: string): Promise<git.ReadCommitResult> {
    try {
      return await git.readCommit({ fs: this.fs, dir: DIR, oid: revision(oid) });
    } catch {
      throw new RemotishError('NOT_FOUND', 'Git commit is unavailable in this session.');
    }
  }

  async getRepository(options?: RemoteRequestOptions): Promise<RepositoryInfo> {
    await this.ready(options?.signal);
    const name =
      new URL(this.url).pathname
        .split('/')
        .at(-1)
        ?.replace(/\.git$/u, '') ?? 'repository';
    return { id: this.url, name, defaultBranch: this.defaultBranch ?? 'HEAD' };
  }

  async getBranches(options?: RemoteRequestOptions): Promise<readonly Branch[]> {
    await this.ready(options?.signal);
    await this.refresh(options?.signal);
    const names = await git.listBranches({ fs: this.fs, dir: DIR, remote: 'origin' });
    if (names.length > MAX_BRANCHES) {
      throw new RemotishError('UNSUPPORTED', 'Git remote has too many branches.');
    }
    return Promise.all(
      names
        .filter((name) => name !== 'HEAD')
        .map(async (name) => ({
          name,
          revision: await git.resolveRef({
            fs: this.fs,
            dir: DIR,
            ref: `refs/remotes/origin/${name}`,
          }),
          ...(name === this.defaultBranch ? { isDefault: true } : {}),
        })),
    );
  }

  async readDirectory(
    oid: RevisionId,
    path: RepoPath,
    options?: RemoteRequestOptions,
  ): Promise<readonly DirectoryEntry[]> {
    await this.ready(options?.signal);
    this.check(options?.signal);
    const normalized = path ? safePath(path) : '';
    await this.commitObject(oid);
    let tree: git.ReadTreeResult;
    try {
      tree = await git.readTree({
        fs: this.fs,
        dir: DIR,
        oid,
        ...(normalized ? { filepath: normalized } : {}),
      });
    } catch {
      throw new RemotishError('NOT_FOUND', 'Git directory does not exist.');
    }
    return tree.tree.map((entry) => ({
      name: entry.path,
      path: normalized ? `${normalized}/${entry.path}` : entry.path,
      type: entry.type === 'tree' ? 'directory' : 'file',
    }));
  }

  async readFile(
    oid: RevisionId,
    path: RepoPath,
    options?: RemoteRequestOptions,
  ): Promise<Uint8Array> {
    await this.ready(options?.signal);
    this.check(options?.signal);
    await this.commitObject(oid);
    const normalized = safePath(path);
    try {
      const result = await git.readBlob({ fs: this.fs, dir: DIR, oid, filepath: normalized });
      return new Uint8Array(result.blob);
    } catch {
      throw new RemotishError('NOT_FOUND', 'Git file does not exist.');
    }
  }

  async getCommits(request: CommitQuery, options?: RemoteRequestOptions): Promise<CommitPage> {
    const signal = options?.signal;
    await this.ready(signal);
    this.check(signal);
    const limit = Math.max(1, Math.min(100, request.limit ?? 50));
    let head: string;
    let offset = 0;
    if (request.cursor) {
      const match = [...request.cursor.matchAll(/^([0-9a-f]{40}):(\d{1,5})$/gmu)][0];
      const cursorHead = match?.[1];
      const cursorOffset = match?.[2];
      if (!cursorHead || !cursorOffset) {
        throw new RemotishError('INVALID_REQUEST', 'Invalid Git history cursor.');
      }
      head = cursorHead;
      offset = Number(cursorOffset);
    } else if (request.revision) {
      head = revision(request.revision);
    } else {
      const name = branch(request.branch ?? this.defaultBranch ?? '');
      const branches = await this.getBranches(options);
      const found = branches.find((candidate) => candidate.name === name);
      if (!found) {
        throw new RemotishError('NOT_FOUND', 'Git branch does not exist.');
      }
      head = found.revision;
    }
    if (offset + limit + 1 > MAX_HISTORY) {
      throw new RemotishError('UNSUPPORTED', 'Git history exceeds the pilot pagination limit.');
    }
    await this.commitObject(head);
    const entries = await git.log({ fs: this.fs, dir: DIR, ref: head, depth: offset + limit + 1 });
    const page = entries.slice(offset, offset + limit).map((item) => info(item.oid, item.commit));
    return entries.length > offset + limit
      ? { commits: page, nextCursor: `${head}:${offset + limit}` }
      : { commits: page };
  }

  private async files(oid: string): Promise<Map<string, FileEntry>> {
    const root = (await this.commitObject(oid)).commit.tree;
    const files = new Map<string, FileEntry>();
    const visit = async (treeOid: string, prefix: string): Promise<void> => {
      const tree = await git.readTree({ fs: this.fs, dir: DIR, oid: treeOid });
      for (const entry of tree.tree) {
        const path = prefix ? `${prefix}/${entry.path}` : entry.path;
        if (entry.type === 'tree') {
          await visit(entry.oid, path);
        } else if (entry.type === 'blob') {
          files.set(path, { oid: entry.oid, mode: entry.mode });
        } else {
          throw new RemotishError('UNSUPPORTED', 'Git submodules are not supported.');
        }
        if (files.size > MAX_TREE_ENTRIES) {
          throw new RemotishError('UNSUPPORTED', 'Git tree exceeds the pilot entry limit.');
        }
      }
    };
    await visit(root, '');
    return files;
  }

  async getCommitChanges(
    oid: RevisionId,
    options?: RemoteRequestOptions,
  ): Promise<readonly CommitChange[]> {
    await this.ready(options?.signal);
    this.check(options?.signal);
    const current = await this.files(oid);
    const parent = (await this.commitObject(oid)).commit.parent[0];
    const previous = parent ? await this.files(parent) : new Map<string, FileEntry>();
    const changes: CommitChange[] = [];
    for (const [path, entry] of current) {
      const old = previous.get(path);
      if (!old) {
        changes.push({ type: 'added', path });
      } else if (old.oid !== entry.oid || old.mode !== entry.mode) {
        changes.push({ type: 'modified', path });
      }
    }
    for (const path of previous.keys()) {
      if (!current.has(path)) {
        changes.push({ type: 'deleted', path });
      }
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async writeTree(files: ReadonlyMap<string, FileEntry>): Promise<string> {
    const directories = new Map<string, git.TreeEntry[]>();
    directories.set('', []);
    for (const [path, entry] of files) {
      const parts = path.split('/');
      const name = parts.pop();
      if (!name) {
        throw new RemotishError('INVALID_REQUEST', 'Invalid Git file path.');
      }
      const parent = parts.join('/');
      for (let i = 1; i <= parts.length; i += 1) {
        const dir = parts.slice(0, i).join('/');
        if (files.has(dir)) {
          throw new RemotishError('INVALID_REQUEST', 'File and directory paths overlap.');
        }
        if (!directories.has(dir)) {
          directories.set(dir, []);
        }
      }
      directories.get(parent)?.push({ path: name, oid: entry.oid, mode: entry.mode, type: 'blob' });
    }
    const sorted = [...directories.keys()].sort(
      (a, b) => b.split('/').length - a.split('/').length,
    );
    let root = '';
    for (const path of sorted) {
      const oid = await git.writeTree({ fs: this.fs, dir: DIR, tree: directories.get(path) ?? [] });
      if (!path) {
        root = oid;
      } else {
        const parts = path.split('/');
        const name = parts.pop();
        if (!name) {
          throw new RemotishError('INVALID_REQUEST', 'Invalid Git directory path.');
        }
        directories.get(parts.join('/'))?.push({ path: name, oid, mode: '040000', type: 'tree' });
      }
    }
    return root;
  }

  private async push(
    localOid: string,
    target: string,
    expected: string,
    force: boolean,
    signal?: AbortSignal,
    deleting = false,
  ): Promise<{ readonly stale: boolean; readonly remoteRevision?: string }> {
    const localRef = `refs/remotish/publish/${crypto.randomUUID().replaceAll('-', '')}`;
    let observed: string | undefined;
    let requestAttempted = false;
    let localRefWritten = false;
    try {
      await git.writeRef({
        fs: this.fs,
        dir: DIR,
        ref: localRef,
        value: deleting ? expected : localOid,
      });
      localRefWritten = true;
      const result = await git.push({
        fs: this.fs,
        http: this.http(signal, () => {
          requestAttempted = true;
        }),
        dir: DIR,
        url: this.url,
        remote: 'origin',
        ref: localRef,
        remoteRef: target,
        force,
        delete: deleting,
        ...(signal ? { signal } : {}),
        onPrePush({ remoteRef }) {
          observed = remoteRef.oid;
          return observed === expected;
        },
      });
      if (!result.ok || result.refs[target]?.ok !== true) {
        // The server replied with a definite ref rejection. A different head is a stale lease;
        // other server failures are operational and may need independent recovery evidence.
        const current = await this.remoteHead(target, signal);
        if (current !== expected) {
          return { stale: true, ...(current ? { remoteRevision: current } : {}) };
        }
        throw new RemotishError('UNKNOWN', 'Git server rejected the ref update.');
      }
      return { stale: false };
    } catch (error) {
      if (observed !== undefined && observed !== expected) {
        return { stale: true, ...(observed !== ZERO_OID ? { remoteRevision: observed } : {}) };
      }
      if (isDefiniteRefRejection(error, target)) {
        const current = await this.remoteHead(target, signal);
        if (current !== expected) {
          return { stale: true, ...(current ? { remoteRevision: current } : {}) };
        }
      }
      if (!requestAttempted && !(error instanceof GitHttpNotDispatchedError)) {
        throw new GitHttpNotDispatchedError(
          normalizeGitHttpError(error).code,
          'Git publication failed before receive-pack dispatch.',
          { cause: error },
        );
      }
      throw normalizeGitHttpError(error);
    } finally {
      if (localRefWritten) {
        await git.deleteRef({ fs: this.fs, dir: DIR, ref: localRef });
      }
    }
  }

  private async remoteHead(ref: string, signal?: AbortSignal): Promise<string | undefined> {
    const remote = await git
      .getRemoteInfo2({
        http: this.http(signal),
        url: this.url,
        forPush: true,
      })
      .catch((error: unknown) => {
        throw normalizeGitHttpError(error);
      });
    return remote.refs?.find((entry) => entry.ref === ref)?.oid;
  }

  async commit(request: CommitRequest, options?: RemoteRequestOptions): Promise<CommitResult> {
    let pushStarted = false;
    try {
      await this.ready(options?.signal);
      this.check(options?.signal);
      const name = branch(request.branch);
      const baseOid = revision(request.baseRevision);
      const expected = revision(
        request.push.mode === 'normal' ? baseOid : request.push.expectedRevision,
      );
      const original = await this.commitObject(baseOid);
      const files = await this.files(baseOid);
      for (const change of request.changes) {
        const path = safePath(change.path);
        if (change.type === 'delete') {
          files.delete(path);
        } else {
          if (change.content.byteLength > 16 * 1024 * 1024) {
            throw new RemotishError('UNSUPPORTED', 'Git file exceeds the pilot size limit.');
          }
          const oid = await git.writeBlob({ fs: this.fs, dir: DIR, blob: change.content });
          files.set(path, { oid, mode: files.get(path)?.mode ?? '100644' });
        }
      }
      if (!request.message.trim()) {
        throw new RemotishError('INVALID_REQUEST', 'Git commit message is empty.');
      }
      const tree = await this.writeTree(files);
      const now = Math.floor(Date.now() / 1000);
      const identity = {
        ...this.options.author,
        timestamp: now,
        timezoneOffset: new Date().getTimezoneOffset(),
      };
      const parent = request.type === 'amend' ? original.commit.parent : [baseOid];
      const commit: git.CommitObject = {
        tree,
        parent,
        message: request.message,
        author: request.type === 'amend' ? original.commit.author : identity,
        committer: identity,
      };
      const oid = await git.writeCommit({ fs: this.fs, dir: DIR, commit });
      const target = `refs/heads/${name}`;
      pushStarted = true;
      const outcome = await this.push(
        oid,
        target,
        expected,
        request.push.mode === 'force-with-lease',
        options?.signal,
      );
      if (outcome.stale) {
        return {
          status: 'rejected',
          reason: 'REMOTE_CHANGED',
          ...(outcome.remoteRevision ? { remoteRevision: outcome.remoteRevision } : {}),
        };
      }
      return { status: 'success', revision: oid, commit: info(oid, commit) };
    } catch (error) {
      if (!pushStarted || error instanceof GitHttpNotDispatchedError) {
        const code = error instanceof RemotishError ? error.code : 'UNKNOWN';
        return {
          status: 'rejected',
          reason: code === 'UNAUTHORIZED' || code === 'FORBIDDEN' ? 'FORBIDDEN' : 'UNSUPPORTED',
          message: `Git publication stopped before receive-pack (${code}). No write was attempted.`,
        };
      }
      throw error;
    }
  }

  async createBranch(
    name: BranchName,
    oid: RevisionId,
    options?: RemoteRequestOptions,
  ): Promise<Branch> {
    await this.ready(options?.signal);
    const target = `refs/heads/${branch(name)}`;
    await this.commitObject(oid);
    const outcome = await this.push(oid, target, ZERO_OID, false, options?.signal);
    if (outcome.stale) {
      throw new RemotishError('INVALID_REQUEST', 'Git branch already exists.');
    }
    return { name, revision: oid };
  }

  async deleteBranch(name: BranchName, options?: RemoteRequestOptions): Promise<void> {
    await this.ready(options?.signal);
    if (name === this.defaultBranch) {
      throw new RemotishError('FORBIDDEN', 'Cannot delete the default branch.');
    }
    const target = `refs/heads/${branch(name)}`;
    const expected = await this.remoteHead(target, options?.signal);
    if (!expected) {
      throw new RemotishError('NOT_FOUND', 'Git branch does not exist.');
    }
    const outcome = await this.push(ZERO_OID, target, expected, false, options?.signal, true);
    if (outcome.stale) {
      throw new RemotishError('INVALID_REQUEST', 'Git branch moved before deletion.');
    }
  }
}
