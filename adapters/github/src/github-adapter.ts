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
  type RemoteRequestOptions,
  type RemotishAdapter,
  type RemotishCapabilities,
  RemotishError,
  type RepoPath,
  type RepositoryInfo,
  type RevisionId,
} from '@remotish/adapter-sdk';
import { GitHubClient } from './github-client.js';
import {
  decodeBranches,
  decodeCommitDetail,
  decodeCommitList,
  decodeRepository,
} from './github-json.js';
import { GitHubPublisher } from './github-publisher.js';
import { GitHubRepositoryView } from './repository-view.js';
import type {
  GitHubAdapterOptions,
  GitHubCommitAuthor,
  GitHubCommitFileResponse,
  GitHubCommitListResponse,
  GitHubRepositoryResponse,
} from './types.js';

const MAX_PAGINATION_PAGES = 100;

/**
 * GitHub implementation of the Remotish adapter contract.
 *
 * Public repositories can be browsed without authentication. Mutating operations require a token
 * with permission to write repository contents. All GitHub JSON is validated before it enters the
 * adapter's typed domain model.
 */
export class GitHubAdapter implements RemotishAdapter {
  readonly capabilities: RemotishCapabilities;

  private readonly client: GitHubClient;
  private readonly publisher: GitHubPublisher;
  private readonly view: GitHubRepositoryView;
  private repositoryCache: GitHubRepositoryResponse | undefined;

  constructor(options: GitHubAdapterOptions) {
    this.client = new GitHubClient(options);
    this.view = new GitHubRepositoryView(this.client);
    this.publisher = new GitHubPublisher(this.client, this.view, (signal) =>
      this.repository(signal),
    );
    this.capabilities = {
      commits: this.client.authenticated,
      forceWithLease: this.client.authenticated,
      amend: this.client.authenticated,
      createBranch: this.client.authenticated,
      deleteBranch: this.client.authenticated,
    };
  }

  async getRepository(options?: RemoteRequestOptions): Promise<RepositoryInfo> {
    const repository = await this.repository(options?.signal);
    if (repository.description) {
      return {
        id: repository.full_name,
        name: repository.name,
        defaultBranch: repository.default_branch,
        description: repository.description,
      };
    }

    return {
      id: repository.full_name,
      name: repository.name,
      defaultBranch: repository.default_branch,
    };
  }

  async readDirectory(
    revision: RevisionId,
    path: RepoPath,
    options?: RemoteRequestOptions,
  ): Promise<readonly DirectoryEntry[]> {
    return this.view.readDirectory(revision, path, options?.signal);
  }

  async readFile(
    revision: RevisionId,
    path: RepoPath,
    options?: RemoteRequestOptions,
  ): Promise<Uint8Array> {
    return this.view.readFile(revision, path, options?.signal);
  }

  async getBranches(options?: RemoteRequestOptions): Promise<readonly Branch[]> {
    const repository = await this.repository(options?.signal);
    const branches: Branch[] = [];

    for (let page = 1; ; page += 1) {
      const batch = await this.client.rest(
        this.repoPath(`/branches?per_page=100&page=${page}`),
        decodeBranches,
        {},
        options?.signal,
      );

      for (const branch of batch) {
        if (branch.name === repository.default_branch) {
          branches.push({ name: branch.name, revision: branch.commit.sha, isDefault: true });
        } else {
          branches.push({ name: branch.name, revision: branch.commit.sha });
        }
      }

      if (batch.length < 100) {
        break;
      }
      if (page >= MAX_PAGINATION_PAGES) {
        throw new RemotishError(
          'UNSUPPORTED',
          `GitHub branch listing exceeded ${MAX_PAGINATION_PAGES} pages.`,
        );
      }
    }

    return branches;
  }

  async getCommits(request: CommitQuery, options?: RemoteRequestOptions): Promise<CommitPage> {
    const limit = Math.max(1, Math.min(100, request.limit ?? 50));
    const page = parseCursor(request.cursor);
    const ref =
      request.revision ?? request.branch ?? (await this.getRepository(options)).defaultBranch;
    const commits = await this.client.rest(
      this.repoPath(`/commits?sha=${encodeURIComponent(ref)}&per_page=${limit}&page=${page}`),
      decodeCommitList,
      {},
      options?.signal,
    );

    if (commits.length === limit) {
      return { commits: commits.map(toCommitInfoFromList), nextCursor: String(page + 1) };
    }
    return { commits: commits.map(toCommitInfoFromList) };
  }

  async getCommitChanges(
    revision: RevisionId,
    options?: RemoteRequestOptions,
  ): Promise<readonly CommitChange[]> {
    const changes: CommitChange[] = [];

    for (let page = 1; ; page += 1) {
      const commit = await this.client.rest(
        this.repoPath(`/commits/${encodeURIComponent(revision)}?per_page=100&page=${page}`),
        decodeCommitDetail,
        {},
        options?.signal,
      );
      const files = commit.files ?? [];
      changes.push(...files.map(toCommitChange));
      if (files.length < 100) {
        break;
      }
      if (page >= MAX_PAGINATION_PAGES) {
        throw new RemotishError(
          'UNSUPPORTED',
          `GitHub commit change listing exceeded ${MAX_PAGINATION_PAGES} pages.`,
        );
      }
    }

    return changes;
  }

  async commit(request: CommitRequest, options?: RemoteRequestOptions): Promise<CommitResult> {
    return this.publisher.commit(request, options?.signal);
  }

  async createBranch(
    name: BranchName,
    revision: RevisionId,
    options?: RemoteRequestOptions,
  ): Promise<Branch> {
    this.requireAuthentication();
    await this.client.restVoid(
      this.repoPath('/git/refs'),
      {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${name}`, sha: revision }),
      },
      options?.signal,
    );
    return { name, revision };
  }

  async deleteBranch(name: BranchName, options?: RemoteRequestOptions): Promise<void> {
    this.requireAuthentication();
    await this.client.restVoid(
      this.repoPath(`/git/refs/heads/${encodeRef(name)}`),
      { method: 'DELETE' },
      options?.signal,
    );
  }

  private async repository(signal?: AbortSignal): Promise<GitHubRepositoryResponse> {
    if (this.repositoryCache) {
      return this.repositoryCache;
    }
    this.repositoryCache = await this.client.rest(this.repoPath(''), decodeRepository, {}, signal);
    return this.repositoryCache;
  }

  private requireAuthentication(): void {
    if (!this.client.authenticated) {
      throw new RemotishError('FORBIDDEN', 'A GitHub token is required for this operation.');
    }
  }

  private repoPath(suffix: string): string {
    return `/repos/${encodeURIComponent(this.client.owner)}/${encodeURIComponent(this.client.repository)}${suffix}`;
  }
}

function toCommitInfoFromList(commit: GitHubCommitListResponse): CommitInfo {
  const author = toCommitAuthor(commit.commit.author);
  const authoredAt = commit.commit.author?.date;

  return {
    revision: commit.sha,
    parents: commit.parents.map((parent) => parent.sha),
    message: commit.commit.message,
    ...(author ? { author } : {}),
    ...(authoredAt ? { authoredAt } : {}),
  };
}

function toCommitAuthor(
  author: GitHubCommitAuthor | null | undefined,
): CommitInfo['author'] | undefined {
  if (!author?.name) {
    return undefined;
  }
  if (author.email) {
    return { name: author.name, email: author.email };
  }
  return { name: author.name };
}

function toCommitChange(file: GitHubCommitFileResponse): CommitChange {
  if (file.status === 'renamed') {
    if (file.previous_filename) {
      return { type: 'renamed', path: file.filename, previousPath: file.previous_filename };
    }
    return { type: 'renamed', path: file.filename };
  }
  if (file.status === 'added') {
    return { type: 'added', path: file.filename };
  }
  if (file.status === 'removed') {
    return { type: 'deleted', path: file.filename };
  }
  return { type: 'modified', path: file.filename };
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 1;
  }
  const page = Number.parseInt(cursor, 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function encodeRef(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}
