import type { Disposable as CoreDisposable, RemotishWorkspace } from '@remotish/core';
import * as vscode from 'vscode';
import { withCancellation } from './cancellation.js';
import {
  branchRef,
  type HistoryRefModel,
  toHistoryChange,
  toHistoryItem,
  workspaceRef,
} from './history-model.js';
import { HistoryQueryService } from './history-query-service.js';

/** Adapts Remotish history queries to VS Code's native SourceControlHistoryProvider API. */
export class RemotishHistoryProvider
  implements vscode.SourceControlHistoryProvider, vscode.Disposable
{
  private readonly currentRefsChanged = new vscode.EventEmitter<void>();
  private readonly refsChanged =
    new vscode.EventEmitter<vscode.SourceControlHistoryItemRefsChangeEvent>();
  private readonly workspaceSubscription: CoreDisposable;
  private readonly queries: HistoryQueryService;
  private remoteRefs = new Map<string, vscode.SourceControlHistoryItemRef>();
  private _currentHistoryItemRef: vscode.SourceControlHistoryItemRef;
  private _currentHistoryItemRemoteRef: vscode.SourceControlHistoryItemRef | undefined;

  readonly onDidChangeCurrentHistoryItemRefs = this.currentRefsChanged.event;
  readonly onDidChangeHistoryItemRefs = this.refsChanged.event;
  readonly currentHistoryItemBaseRef = undefined;

  constructor(
    private readonly workspaceId: string,
    private readonly workspace: RemotishWorkspace,
  ) {
    this.queries = new HistoryQueryService(workspace);
    this._currentHistoryItemRef = toRef(workspaceRef(workspace.branch, workspace.baseRevision));
    this.workspaceSubscription = workspace.onDidChange(() => {
      this._currentHistoryItemRef = toRef(workspaceRef(workspace.branch, workspace.baseRevision));
      this.currentRefsChanged.fire();
      void this.refreshRemoteRefs(false);
    });
    void this.refreshRemoteRefs(true);
  }

  get currentHistoryItemRef(): vscode.SourceControlHistoryItemRef {
    return this._currentHistoryItemRef;
  }

  get currentHistoryItemRemoteRef(): vscode.SourceControlHistoryItemRef | undefined {
    return this._currentHistoryItemRemoteRef;
  }

  async provideHistoryItemRefs(
    historyItemRefs: string[] | undefined,
    token: vscode.CancellationToken,
  ): Promise<vscode.SourceControlHistoryItemRef[]> {
    if (token.isCancellationRequested) {
      return [];
    }
    const branches = await this.workspace.listBranches();
    if (token.isCancellationRequested) {
      return [];
    }
    const refs = [
      toRef(workspaceRef(this.workspace.branch, this.workspace.baseRevision)),
      ...branches.map((branch) => toRef(branchRef(branch))),
    ];
    if (!historyItemRefs?.length) {
      return refs;
    }
    const requested = new Set(historyItemRefs);
    return refs.filter((ref) => requested.has(ref.id) || requested.has(ref.name));
  }

  async provideHistoryItems(
    options: vscode.SourceControlHistoryOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.SourceControlHistoryItem[]> {
    if (token.isCancellationRequested) {
      return [];
    }
    const skip = Math.max(0, options.skip ?? 0);
    const numericLimit = typeof options.limit === 'number' ? options.limit : 50;
    const limit = Math.max(1, numericLimit ?? 50);
    const anchor = typeof options.limit === 'object' ? options.limit.id : undefined;
    const targetCount = skip + limit;

    const commits = anchor
      ? await this.queries.loadCommits({ revision: anchor }, targetCount, token)
      : await this.queries.loadRefCommits(options.historyItemRefs, targetCount, token);
    if (token.isCancellationRequested) {
      return [];
    }

    const filter = options.filterText?.trim().toLocaleLowerCase();
    const filtered = filter
      ? commits.filter(
          (commit) =>
            commit.message.toLocaleLowerCase().includes(filter) ||
            commit.author?.name.toLocaleLowerCase().includes(filter) ||
            commit.author?.email?.toLocaleLowerCase().includes(filter),
        )
      : commits;
    return filtered.slice(skip, skip + limit).map((commit) => toHistoryItem(commit));
  }

  async provideHistoryItemChanges(
    historyItemId: string,
    historyItemParentId: string | undefined,
    token: vscode.CancellationToken,
  ): Promise<vscode.SourceControlHistoryItemChange[]> {
    const changes = await withCancellation(token, (options) =>
      this.workspace.getCommitChanges(historyItemId, options),
    );
    if (token.isCancellationRequested) {
      return [];
    }
    return changes.map((change) => {
      const model = toHistoryChange(this.workspaceId, historyItemId, historyItemParentId, change);
      return {
        uri: vscode.Uri.from(model.uri),
        originalUri: model.originalUri ? vscode.Uri.from(model.originalUri) : undefined,
        modifiedUri: model.modifiedUri ? vscode.Uri.from(model.modifiedUri) : undefined,
      };
    });
  }

  async resolveHistoryItem(
    historyItemId: string,
    token: vscode.CancellationToken,
  ): Promise<vscode.SourceControlHistoryItem | undefined> {
    const page = await withCancellation(token, (options) =>
      this.workspace.getCommits({ revision: historyItemId, limit: 1 }, options),
    );
    const commit = page.commits.find((candidate) => candidate.revision === historyItemId);
    return commit ? toHistoryItem(commit) : undefined;
  }

  resolveHistoryItemChatContext(): undefined {
    return undefined;
  }

  resolveHistoryItemChangeRangeChatContext(): undefined {
    return undefined;
  }

  resolveHistoryItemRefsCommonAncestor(
    historyItemRefs: string[],
    token: vscode.CancellationToken,
  ): Promise<string | undefined> {
    return this.queries.resolveCommonAncestor(historyItemRefs, token);
  }

  dispose(): void {
    this.workspaceSubscription.dispose();
    this.currentRefsChanged.dispose();
    this.refsChanged.dispose();
  }

  private async refreshRemoteRefs(silent: boolean): Promise<void> {
    const branches = await this.workspace.listBranches();
    const next = new Map(
      branches.map((branch) => {
        const ref = toRef(branchRef(branch));
        return [ref.id, ref] as const;
      }),
    );
    const added: vscode.SourceControlHistoryItemRef[] = [];
    const removed: vscode.SourceControlHistoryItemRef[] = [];
    const modified: vscode.SourceControlHistoryItemRef[] = [];

    for (const [id, ref] of next) {
      const previous = this.remoteRefs.get(id);
      if (!previous) {
        added.push(ref);
      } else if (previous.revision !== ref.revision || previous.name !== ref.name) {
        modified.push(ref);
      }
    }
    for (const [id, ref] of this.remoteRefs) {
      if (!next.has(id)) {
        removed.push(ref);
      }
    }

    this.remoteRefs = next;
    this._currentHistoryItemRemoteRef = next.get(`branch:${this.workspace.branch}`);
    this.currentRefsChanged.fire();
    if (added.length || removed.length || modified.length) {
      this.refsChanged.fire({ added, removed, modified, silent });
    }
  }
}

function toRef(model: HistoryRefModel): vscode.SourceControlHistoryItemRef {
  return {
    id: model.id,
    name: model.name,
    revision: model.revision,
    category: model.category,
  };
}
