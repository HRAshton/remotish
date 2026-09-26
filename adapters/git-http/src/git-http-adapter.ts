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
  RemotishError,
  type RepoPath,
  type RepositoryInfo,
  type RevisionId,
} from '@remotish/adapter-sdk';
import { GitCommitBuilder } from './git-commit-builder.js';
import { GitPublisher } from './git-publisher.js';
import { GitReader } from './git-reader.js';
import { GitSession } from './git-session.js';
import {
  requireBranch,
  requireNotAborted,
  requireRevision,
  toCommitInfo,
  ZERO_OID,
} from './git-validation.js';
import { type GitHttpAdapterOptions, GitHttpNotDispatchedError } from './transport.js';

/** Remotish adapter over one Git smart-HTTP repository. */
export class GitHttpAdapter implements RemotishAdapter {
  readonly capabilities = {
    commits: true,
    forceWithLease: true,
    amend: true,
    createBranch: true,
    deleteBranch: true,
  } as const;

  private readonly session: GitSession;
  private readonly reader: GitReader;
  private readonly builder: GitCommitBuilder;
  private readonly publisher: GitPublisher;

  constructor(options: GitHttpAdapterOptions) {
    this.session = new GitSession(options);
    this.reader = new GitReader(this.session);
    this.builder = new GitCommitBuilder(this.session, this.reader);
    this.publisher = new GitPublisher(this.session);
  }

  async getRepository(options?: RemoteRequestOptions): Promise<RepositoryInfo> {
    await this.session.ready(options?.signal);
    const name =
      new URL(this.session.url).pathname
        .split('/')
        .at(-1)
        ?.replace(/\.git$/u, '') ?? 'repository';
    return { id: this.session.url, name, defaultBranch: this.session.defaultBranch ?? 'HEAD' };
  }

  getBranches(options?: RemoteRequestOptions): Promise<readonly Branch[]> {
    return this.reader.branches(options);
  }

  readDirectory(
    revision: RevisionId,
    path: RepoPath,
    options?: RemoteRequestOptions,
  ): Promise<readonly DirectoryEntry[]> {
    return this.reader.readDirectory(revision, path, options);
  }

  readFile(
    revision: RevisionId,
    path: RepoPath,
    options?: RemoteRequestOptions,
  ): Promise<Uint8Array> {
    return this.reader.readFile(revision, path, options);
  }

  getCommits(request: CommitQuery, options?: RemoteRequestOptions): Promise<CommitPage> {
    return this.reader.commits(request, options);
  }

  getCommitChanges(
    revision: RevisionId,
    options?: RemoteRequestOptions,
  ): Promise<readonly CommitChange[]> {
    return this.reader.changes(revision, options);
  }

  async commit(request: CommitRequest, options?: RemoteRequestOptions): Promise<CommitResult> {
    let pushStarted = false;
    try {
      await this.session.ready(options?.signal);
      requireNotAborted(options?.signal);
      const name = requireBranch(request.branch);
      const baseOid = requireRevision(request.baseRevision);
      const expected = requireRevision(
        request.push.mode === 'normal' ? baseOid : request.push.expectedRevision,
      );
      const { oid, commit } = await this.builder.build(request, baseOid);
      const target = `refs/heads/${name}`;
      pushStarted = true;
      const outcome = await this.publisher.update(
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
      if (outcome.rejected) {
        return {
          status: 'rejected',
          reason: 'UNSUPPORTED',
          message: 'Git server rejected the ref update.',
        };
      }
      return { status: 'success', revision: oid, commit: toCommitInfo(oid, commit) };
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
    revision: RevisionId,
    options?: RemoteRequestOptions,
  ): Promise<Branch> {
    await this.session.ready(options?.signal);
    const branch = requireBranch(name);
    const oid = requireRevision(revision);
    await this.session.commitObject(oid);
    const outcome = await this.publisher.update(
      oid,
      `refs/heads/${branch}`,
      ZERO_OID,
      false,
      options?.signal,
    );
    if (outcome.stale) {
      throw new RemotishError('INVALID_REQUEST', 'Git branch already exists.');
    }
    if (outcome.rejected) {
      throw new RemotishError('UNKNOWN', 'Git server rejected the branch update.');
    }
    return { name, revision: oid };
  }

  async deleteBranch(name: BranchName, options?: RemoteRequestOptions): Promise<void> {
    await this.session.ready(options?.signal);
    if (name === this.session.defaultBranch) {
      throw new RemotishError('FORBIDDEN', 'Cannot delete the default branch.');
    }
    const branch = requireBranch(name);
    const target = `refs/heads/${branch}`;
    const expected = await this.publisher.remoteHead(target, options?.signal);
    if (!expected) {
      throw new RemotishError('NOT_FOUND', 'Git branch does not exist.');
    }
    const outcome = await this.publisher.update(
      ZERO_OID,
      target,
      expected,
      false,
      options?.signal,
      true,
    );
    if (outcome.stale) {
      throw new RemotishError('INVALID_REQUEST', 'Git branch moved before deletion.');
    }
    if (outcome.rejected) {
      throw new RemotishError('UNKNOWN', 'Git server rejected the branch deletion.');
    }
  }
}
