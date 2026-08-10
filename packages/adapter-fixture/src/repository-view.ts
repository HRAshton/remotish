import {
  type Branch,
  type CommitChange,
  type CommitInfo,
  type CommitPage,
  type CommitQuery,
  type DirectoryEntry,
  RemotishError,
  type RevisionId,
} from '@remotish/adapter-sdk';
import { diffFiles } from './files.js';
import type { FixtureRepository, StoredCommit } from './model.js';
import { normalizePath } from './path.js';
import { cloneCommitInfo, compareDirectoryEntries, parseCursor } from './support.js';

/** Provides immutable file and directory reads over the fixture commit graph. */
export class FixtureRepositoryView {
  constructor(private readonly repository: FixtureRepository) {}

  readDirectory(revision: RevisionId, path: string): readonly DirectoryEntry[] {
    const files = this.requireCommit(revision).files;
    const normalized = normalizePath(path);
    if (normalized && files.has(normalized)) {
      throw new RemotishError('INVALID_REQUEST', `${normalized} is not a directory.`);
    }
    const prefix = normalized ? `${normalized}/` : '';
    if (normalized && ![...files.keys()].some((file) => file.startsWith(prefix))) {
      throw new RemotishError('NOT_FOUND', `Directory ${normalized} does not exist.`);
    }

    const entries = new Map<string, DirectoryEntry>();
    for (const [filePath, content] of files) {
      if (!filePath.startsWith(prefix)) {
        continue;
      }
      const remainder = filePath.slice(prefix.length);
      const separator = remainder.indexOf('/');
      const name = separator < 0 ? remainder : remainder.slice(0, separator);
      if (!name) {
        continue;
      }
      const entryPath = normalized ? `${normalized}/${name}` : name;
      const type = separator < 0 ? 'file' : 'directory';
      entries.set(name, {
        name,
        path: entryPath,
        type,
        ...(type === 'file' ? { size: content.byteLength } : {}),
      });
    }
    return [...entries.values()].sort(compareDirectoryEntries);
  }

  readFile(revision: RevisionId, path: string): Uint8Array {
    const normalized = normalizePath(path);
    const content = this.requireCommit(revision).files.get(normalized);
    if (!content) {
      throw new RemotishError('NOT_FOUND', `File ${normalized} does not exist.`);
    }
    return content.slice();
  }

  getBranches(): readonly Branch[] {
    return [...this.repository.branches]
      .map(([name, revision]) => ({
        name,
        revision,
        ...(name === this.repository.info.defaultBranch ? { isDefault: true } : {}),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getCommits(request: CommitQuery): CommitPage {
    const start = this.resolveQueryRevision(request);
    const limit = Math.max(1, Math.min(100, Math.trunc(request.limit ?? 50)));
    const offset = parseCursor(request.cursor);
    const history = this.firstParentHistory(start);
    const commits = history.slice(offset, offset + limit);
    const nextOffset = offset + commits.length;
    return {
      commits,
      ...(nextOffset < history.length ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  getCommitChanges(revision: RevisionId): readonly CommitChange[] {
    const commit = this.requireCommit(revision);
    const parentRevision = commit.info.parents[0];
    const parentFiles = parentRevision
      ? this.requireCommit(parentRevision).files
      : new Map<string, Uint8Array>();
    return diffFiles(parentFiles, commit.files);
  }

  requireCommit(revision: RevisionId): StoredCommit {
    const commit = this.repository.commits.get(revision);
    if (!commit) {
      throw new RemotishError('NOT_FOUND', `Revision ${revision} does not exist.`);
    }
    return commit;
  }

  private resolveQueryRevision(request: CommitQuery): RevisionId {
    if (request.revision) {
      this.requireCommit(request.revision);
      return request.revision;
    }
    const branch = request.branch ?? this.repository.info.defaultBranch;
    const revision = this.repository.branches.get(branch);
    if (!revision) {
      throw new RemotishError('NOT_FOUND', `Branch ${branch} does not exist.`);
    }
    return revision;
  }

  private firstParentHistory(start: RevisionId): CommitInfo[] {
    const history: CommitInfo[] = [];
    let current: RevisionId | undefined = start;
    while (current) {
      const commit = this.requireCommit(current);
      history.push(cloneCommitInfo(commit.info));
      current = commit.info.parents[0];
    }
    return history;
  }
}
