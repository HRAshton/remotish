import type { CommitInfo } from '@remotish/adapter-sdk';
import type { RemotishWorkspace } from '@remotish/core';
import type * as vscode from 'vscode';
import { withCancellation } from './cancellation.js';
import { branchNameFromRef } from './history-model.js';

type CommitStart = { readonly branch: string } | { readonly revision: string };

/** Resolves commits, refs, and common ancestors for native SCM history requests. */
export class HistoryQueryService {
  constructor(private readonly workspace: RemotishWorkspace) {}

  async loadRefCommits(
    refs: readonly string[] | undefined,
    count: number,
    token: vscode.CancellationToken,
  ): Promise<CommitInfo[]> {
    const requested = refs?.length ? refs : [`workspace:${this.workspace.branch}`];
    const queries = await Promise.all(requested.map((ref) => this.queryForRef(ref, token)));
    const histories = await Promise.all(
      queries
        .filter((query): query is CommitStart => query !== undefined)
        .map((query) => this.loadCommits(query, count, token)),
    );
    const commits = new Map<string, CommitInfo>();
    for (const history of histories) {
      for (const commit of history) {
        commits.set(commit.revision, commit);
      }
    }
    return [...commits.values()].sort(compareCommitsNewestFirst).slice(0, count);
  }

  async resolveCommonAncestor(
    refs: readonly string[],
    token: vscode.CancellationToken,
  ): Promise<string | undefined> {
    if (refs.length === 0) {
      return undefined;
    }
    const revisions = await Promise.all(refs.map((ref) => this.resolveRefRevision(ref, token)));
    const resolvedRevisions = revisions.filter(
      (revision): revision is string => revision !== undefined,
    );
    if (resolvedRevisions.length !== revisions.length) {
      return undefined;
    }
    const histories = await Promise.all(
      resolvedRevisions.map((revision) => this.loadCommits({ revision }, 500, token)),
    );
    const remaining = histories
      .slice(1)
      .map((history) => new Set(history.map((commit) => commit.revision)));
    return histories[0]?.find((commit) => remaining.every((set) => set.has(commit.revision)))
      ?.revision;
  }

  loadCommits(
    start: CommitStart,
    count: number,
    token: vscode.CancellationToken,
  ): Promise<CommitInfo[]> {
    return this.loadPages(start, count, token);
  }

  private async queryForRef(
    ref: string,
    token: vscode.CancellationToken,
  ): Promise<CommitStart | undefined> {
    if (ref.startsWith('workspace:')) {
      const branch = branchNameFromRef(ref);
      return branch === this.workspace.branch
        ? { revision: this.workspace.baseRevision }
        : undefined;
    }
    const branch = branchNameFromRef(ref);
    if (branch) {
      return { branch };
    }
    const branches = await withCancellation(token, (options) =>
      this.workspace.listBranches(options),
    );
    if (branches.some((candidate) => candidate.name === ref)) {
      return { branch: ref };
    }
    return { revision: ref };
  }

  private async resolveRefRevision(
    ref: string,
    token: vscode.CancellationToken,
  ): Promise<string | undefined> {
    if (ref.startsWith('workspace:')) {
      return branchNameFromRef(ref) === this.workspace.branch
        ? this.workspace.baseRevision
        : undefined;
    }
    const branch = branchNameFromRef(ref) ?? ref;
    const branches = await withCancellation(token, (options) =>
      this.workspace.listBranches(options),
    );
    const remote = branches.find((candidate) => candidate.name === branch);
    return remote?.revision ?? (ref.startsWith('branch:') ? undefined : ref);
  }

  private async loadPages(
    start: CommitStart,
    count: number,
    token: vscode.CancellationToken,
  ): Promise<CommitInfo[]> {
    const result: CommitInfo[] = [];
    let cursor: string | undefined;
    while (result.length < count && !token.isCancellationRequested) {
      const page = await withCancellation(token, (options) =>
        this.workspace.getCommits(
          {
            ...start,
            limit: Math.min(100, count - result.length),
            ...(cursor ? { cursor } : {}),
          },
          options,
        ),
      );
      result.push(...page.commits);
      if (!page.nextCursor) {
        break;
      }
      cursor = page.nextCursor;
    }
    return result;
  }
}

function compareCommitsNewestFirst(left: CommitInfo, right: CommitInfo): number {
  const leftTime = left.authoredAt ? Date.parse(left.authoredAt) : 0;
  const rightTime = right.authoredAt ? Date.parse(right.authoredAt) : 0;
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return left.revision.localeCompare(right.revision);
}
