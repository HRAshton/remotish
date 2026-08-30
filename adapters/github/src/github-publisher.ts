import type {
  BranchName,
  CommitInfo,
  CommitRequest,
  CommitResult,
  RevisionId,
} from '@remotish/adapter-sdk';
import type { GitHubClient } from './github-client.js';
import { decodeGitCommit, decodeObjectSha, decodeSha } from './github-json.js';
import type { GitHubRepositoryView } from './repository-view.js';
import type {
  GitHubCommitAuthor,
  GitHubGitCommitResponse,
  GitHubRepositoryResponse,
} from './types.js';

const UPDATE_REFS_MUTATION = `
mutation RemotishUpdateRefs($input: UpdateRefsInput!) {
  updateRefs(input: $input) { clientMutationId }
}`;

/**
 * Creates Git objects and publishes them with GitHub's atomic ref-update lease.
 *
 * A successful call means the remote branch already points at the returned commit; rejected lease
 * updates are translated back into Remotish's REMOTE_CHANGED domain result.
 */
export class GitHubPublisher {
  constructor(
    private readonly client: GitHubClient,
    private readonly view: GitHubRepositoryView,
    private readonly getRepository: (signal?: AbortSignal) => Promise<GitHubRepositoryResponse>,
  ) {}

  /** Creates one remote commit and conditionally advances its branch. */
  async commit(request: CommitRequest, signal?: AbortSignal): Promise<CommitResult> {
    if (!this.client.authenticated) {
      return {
        status: 'rejected',
        reason: 'FORBIDDEN',
        message: 'A GitHub token is required for commit-and-push operations.',
      };
    }

    const base = await this.view.getCommit(request.baseRevision, signal);
    const treeEntries = await Promise.all(
      request.changes.map(async (change) => {
        if (change.type === 'delete') {
          return { path: change.path, mode: '100644', type: 'blob', sha: null } as const;
        }

        const blob = await this.client.rest(
          this.repoPath('/git/blobs'),
          decodeSha,
          {
            method: 'POST',
            body: JSON.stringify({ content: encodeBase64(change.content), encoding: 'base64' }),
          },
          signal,
        );
        const mode =
          (await this.view.fileMode(request.baseRevision, change.path, signal)) ?? '100644';

        return { path: change.path, mode, type: 'blob', sha: blob.sha } as const;
      }),
    );

    const tree = await this.client.rest(
      this.repoPath('/git/trees'),
      decodeSha,
      {
        method: 'POST',
        body: JSON.stringify({ base_tree: base.tree.sha, tree: treeEntries }),
      },
      signal,
    );

    const parents =
      request.type === 'amend' ? base.parents.map((parent) => parent.sha) : [request.baseRevision];
    const created = await this.client.rest(
      this.repoPath('/git/commits'),
      decodeGitCommit,
      {
        method: 'POST',
        body: JSON.stringify({ message: request.message, tree: tree.sha, parents }),
      },
      signal,
    );

    const expectedRevision =
      request.push.mode === 'force-with-lease'
        ? request.push.expectedRevision
        : request.baseRevision;

    const updated = await this.updateBranch(
      request.branch,
      expectedRevision,
      created.sha,
      request.push.mode === 'force-with-lease',
      signal,
    );

    if (updated !== undefined) {
      return {
        status: 'rejected',
        reason: 'REMOTE_CHANGED',
        remoteRevision: updated,
        message: `Remote branch moved from ${expectedRevision} to ${updated}.`,
      };
    }

    return {
      status: 'success',
      revision: created.sha,
      commit: toCommitInfo(created),
    };
  }

  private async updateBranch(
    branch: BranchName,
    expectedRevision: RevisionId,
    revision: RevisionId,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<RevisionId | undefined> {
    try {
      const repository = await this.getRepository(signal);
      await this.client.graphql(
        UPDATE_REFS_MUTATION,
        {
          input: {
            repositoryId: repository.node_id,
            refUpdates: [
              {
                name: `refs/heads/${branch}`,
                beforeOid: expectedRevision,
                afterOid: revision,
                force,
              },
            ],
          },
        },
        signal,
      );
      return undefined;
    } catch (error) {
      const remoteRevision = await this.branchHead(branch, signal).catch(() => undefined);
      if (remoteRevision !== undefined && remoteRevision !== expectedRevision) {
        return remoteRevision;
      }
      throw error;
    }
  }

  private async branchHead(branch: BranchName, signal?: AbortSignal): Promise<RevisionId> {
    const ref = await this.client.rest(
      this.repoPath(`/git/ref/heads/${encodeRef(branch)}`),
      decodeObjectSha,
      {},
      signal,
    );
    return ref.object.sha;
  }

  private repoPath(suffix: string): string {
    return `/repos/${encodeURIComponent(this.client.owner)}/${encodeURIComponent(this.client.repository)}${suffix}`;
  }
}

function toCommitInfo(commit: GitHubGitCommitResponse): CommitInfo {
  const author = toCommitAuthor(commit.author);
  const authoredAt = commit.author?.date;

  return {
    revision: commit.sha,
    parents: commit.parents.map((parent) => parent.sha),
    message: commit.message,
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

function encodeRef(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function encodeBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary);
}
