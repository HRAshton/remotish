import {
  type Branch,
  type CommitChange,
  type CommitPage,
  type CommitQuery,
  type DirectoryEntry,
  type RemoteRequestOptions,
  RemotishError,
  type RepoPath,
  type RevisionId,
} from '@remotish/adapter-sdk';
import * as git from 'isomorphic-git';
import { GIT_DIR, type GitSession } from './git-session.js';
import {
  MAX_BRANCHES,
  MAX_HISTORY,
  MAX_TREE_ENTRIES,
  requireBranch,
  requireNotAborted,
  requireRepoPath,
  requireRevision,
  toCommitInfo,
} from './git-validation.js';

export interface GitFileEntry {
  readonly oid: string;
  readonly mode: string;
}

/** Read-only repository operations over a GitSession. */
export class GitReader {
  constructor(private readonly session: GitSession) {}

  async branches(options?: RemoteRequestOptions): Promise<readonly Branch[]> {
    await this.session.ready(options?.signal);
    await this.session.refresh(options?.signal);
    const names = await git.listBranches({ fs: this.session.fs, dir: GIT_DIR, remote: 'origin' });
    if (names.length > MAX_BRANCHES) {
      throw new RemotishError('UNSUPPORTED', 'Git remote has too many branches.');
    }
    return Promise.all(
      names
        .filter((name) => name !== 'HEAD')
        .map(async (name) => ({
          name,
          revision: await git.resolveRef({
            fs: this.session.fs,
            dir: GIT_DIR,
            ref: `refs/remotes/origin/${name}`,
          }),
          ...(name === this.session.defaultBranch ? { isDefault: true } : {}),
        })),
    );
  }

  async readDirectory(
    oid: RevisionId,
    path: RepoPath,
    options?: RemoteRequestOptions,
  ): Promise<readonly DirectoryEntry[]> {
    await this.session.ready(options?.signal);
    requireNotAborted(options?.signal);
    const normalized = path ? requireRepoPath(path) : '';
    await this.session.commitObject(oid);
    let tree: git.ReadTreeResult;
    try {
      tree = await git.readTree({
        fs: this.session.fs,
        dir: GIT_DIR,
        oid,
        ...(normalized ? { filepath: normalized } : {}),
      });
    } catch {
      throw new RemotishError('NOT_FOUND', 'Git directory does not exist.');
    }
    requireOrdinaryEntries(tree.tree);
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
    await this.session.ready(options?.signal);
    requireNotAborted(options?.signal);
    await this.session.commitObject(oid);
    const normalized = requireRepoPath(path);
    const parts = normalized.split('/');
    const name = parts.pop();
    let directory: git.ReadTreeResult;
    try {
      directory = await git.readTree({
        fs: this.session.fs,
        dir: GIT_DIR,
        oid,
        ...(parts.length ? { filepath: parts.join('/') } : {}),
      });
    } catch {
      throw new RemotishError('NOT_FOUND', 'Git file does not exist.');
    }
    const entry = directory.tree.find((candidate) => candidate.path === name);
    requireOrdinaryEntry(entry);
    if (entry?.type !== 'blob') {
      throw new RemotishError('NOT_FOUND', 'Git file does not exist.');
    }
    try {
      const result = await git.readBlob({
        fs: this.session.fs,
        dir: GIT_DIR,
        oid,
        filepath: normalized,
      });
      return new Uint8Array(result.blob);
    } catch {
      throw new RemotishError('NOT_FOUND', 'Git file does not exist.');
    }
  }

  async commits(request: CommitQuery, options?: RemoteRequestOptions): Promise<CommitPage> {
    const signal = options?.signal;
    await this.session.ready(signal);
    requireNotAborted(signal);
    const limit = Math.max(1, Math.min(100, request.limit ?? 50));
    const { head, offset } = await this.historyPosition(request, options);
    if (offset + limit + 1 > MAX_HISTORY) {
      throw new RemotishError('UNSUPPORTED', 'Git history exceeds the pagination limit.');
    }
    await this.session.commitObject(head);
    const entries = await git.log({
      fs: this.session.fs,
      dir: GIT_DIR,
      ref: head,
      depth: offset + limit + 1,
    });
    const page = entries
      .slice(offset, offset + limit)
      .map((item) => toCommitInfo(item.oid, item.commit));
    return entries.length > offset + limit
      ? { commits: page, nextCursor: `${head}:${offset + limit}` }
      : { commits: page };
  }

  async changes(oid: RevisionId, options?: RemoteRequestOptions): Promise<readonly CommitChange[]> {
    await this.session.ready(options?.signal);
    requireNotAborted(options?.signal);
    const current = await this.files(oid);
    const parent = (await this.session.commitObject(oid)).commit.parent[0];
    const previous = parent ? await this.files(parent) : new Map<string, GitFileEntry>();
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

  async files(oid: string): Promise<Map<string, GitFileEntry>> {
    const root = (await this.session.commitObject(oid)).commit.tree;
    const files = new Map<string, GitFileEntry>();
    const visit = async (treeOid: string, prefix: string): Promise<void> => {
      const tree = await git.readTree({ fs: this.session.fs, dir: GIT_DIR, oid: treeOid });
      for (const entry of tree.tree) {
        const path = prefix ? `${prefix}/${entry.path}` : entry.path;
        if (entry.type === 'tree') {
          await visit(entry.oid, path);
        } else if (entry.type === 'blob' && entry.mode !== '120000') {
          files.set(path, { oid: entry.oid, mode: entry.mode });
        } else {
          throw unsupportedLink();
        }
        if (files.size > MAX_TREE_ENTRIES) {
          throw new RemotishError('UNSUPPORTED', 'Git tree exceeds the entry limit.');
        }
      }
    };
    await visit(root, '');
    return files;
  }

  private async historyPosition(
    request: CommitQuery,
    options?: RemoteRequestOptions,
  ): Promise<{ readonly head: string; readonly offset: number }> {
    if (request.cursor) {
      const match = /^([0-9a-f]{40}):(\d{1,5})$/u.exec(request.cursor);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: RegExp.exec can return null for an invalid cursor.
      if (!match?.[1] || !match[2]) {
        throw new RemotishError('INVALID_REQUEST', 'Invalid Git history cursor.');
      }
      return { head: requireRevision(match[1]), offset: Number(match[2]) };
    }
    if (request.revision) {
      return { head: requireRevision(request.revision), offset: 0 };
    }
    const name = requireBranch(request.branch ?? this.session.defaultBranch ?? '');
    const found = (await this.branches(options)).find((candidate) => candidate.name === name);
    if (!found) {
      throw new RemotishError('NOT_FOUND', 'Git branch does not exist.');
    }
    return { head: found.revision, offset: 0 };
  }
}

function requireOrdinaryEntries(entries: readonly git.TreeEntry[]): void {
  if (entries.some((entry) => entry.type === 'commit' || entry.mode === '120000')) {
    throw unsupportedLink();
  }
}

function requireOrdinaryEntry(entry: git.TreeEntry | undefined): void {
  if (entry?.type === 'commit' || entry?.mode === '120000') {
    throw unsupportedLink();
  }
}

function unsupportedLink(): RemotishError {
  return new RemotishError('UNSUPPORTED', 'Git submodules and symlinks are not supported.');
}
