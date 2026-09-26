import { type CommitRequest, RemotishError } from '@remotish/adapter-sdk';
import * as git from 'isomorphic-git';
import type { GitFileEntry, GitReader } from './git-reader.js';
import { GIT_DIR, type GitSession } from './git-session.js';
import { MAX_FILE_BYTES, requireRepoPath } from './git-validation.js';

/** Builds immutable Git objects from a Remotish commit request; it does not publish refs. */
export class GitCommitBuilder {
  constructor(
    private readonly session: GitSession,
    private readonly reader: GitReader,
  ) {}

  async build(
    request: CommitRequest,
    baseOid: string,
  ): Promise<{ readonly oid: string; readonly commit: git.CommitObject }> {
    const original = await this.session.commitObject(baseOid);
    const files = await this.reader.files(baseOid);
    await this.applyChanges(files, request);
    if (!request.message.trim()) {
      throw new RemotishError('INVALID_REQUEST', 'Git commit message is empty.');
    }
    const tree = await this.writeTree(files);
    const now = Math.floor(Date.now() / 1000);
    const identity = {
      ...this.session.options.author,
      timestamp: now,
      timezoneOffset: new Date().getTimezoneOffset(),
    };
    const commit: git.CommitObject = {
      tree,
      parent: request.type === 'amend' ? original.commit.parent : [baseOid],
      message: request.message,
      author: request.type === 'amend' ? original.commit.author : identity,
      committer: identity,
    };
    const oid = await git.writeCommit({ fs: this.session.fs, dir: GIT_DIR, commit });
    return { oid, commit };
  }

  private async applyChanges(
    files: Map<string, GitFileEntry>,
    request: CommitRequest,
  ): Promise<void> {
    for (const change of request.changes) {
      const path = requireRepoPath(change.path);
      if (change.type === 'delete') {
        files.delete(path);
        continue;
      }
      if (change.content.byteLength > MAX_FILE_BYTES) {
        throw new RemotishError('UNSUPPORTED', 'Git file exceeds the size limit.');
      }
      const oid = await git.writeBlob({ fs: this.session.fs, dir: GIT_DIR, blob: change.content });
      files.set(path, { oid, mode: files.get(path)?.mode ?? '100644' });
    }
  }

  private async writeTree(files: ReadonlyMap<string, GitFileEntry>): Promise<string> {
    const directories = new Map<string, git.TreeEntry[]>([['', []]]);
    for (const [path, entry] of files) {
      const parts = path.split('/');
      const name = parts.pop();
      if (!name) {
        throw new RemotishError('INVALID_REQUEST', 'Invalid Git file path.');
      }
      const parent = parts.join('/');
      for (let i = 1; i <= parts.length; i += 1) {
        const directory = parts.slice(0, i).join('/');
        if (files.has(directory)) {
          throw new RemotishError('INVALID_REQUEST', 'File and directory paths overlap.');
        }
        if (!directories.has(directory)) {
          directories.set(directory, []);
        }
      }
      directories.get(parent)?.push({ path: name, oid: entry.oid, mode: entry.mode, type: 'blob' });
    }

    const deepestFirst = [...directories.keys()].sort(
      (left, right) => right.split('/').length - left.split('/').length,
    );
    let root: string | undefined;
    for (const path of deepestFirst) {
      const entries = directories.get(path);
      if (!entries) {
        throw new RemotishError('UNKNOWN', 'Git tree construction invariant failed.');
      }
      const oid = await git.writeTree({ fs: this.session.fs, dir: GIT_DIR, tree: entries });
      if (!path) {
        root = oid;
        continue;
      }
      const parts = path.split('/');
      const name = parts.pop();
      const parent = directories.get(parts.join('/'));
      if (!name || !parent) {
        throw new RemotishError('UNKNOWN', 'Git tree construction invariant failed.');
      }
      parent.push({ path: name, oid, mode: '040000', type: 'tree' });
    }
    if (!root) {
      throw new RemotishError('UNKNOWN', 'Git tree construction invariant failed.');
    }
    return root;
  }
}
