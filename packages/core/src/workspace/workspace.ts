import type {
  Branch,
  BranchName,
  CommitChange,
  CommitPage,
  CommitQuery,
  CommitResult,
  DirectoryEntry,
  RemoteRequestOptions,
  RemotishAdapter,
  RemotishCapabilities,
  RepoPath,
  RepositoryInfo,
  RevisionId,
} from '@remotish/adapter-sdk';
import { RemotishError } from '@remotish/adapter-sdk';
import {
  type AfterCommitPublish,
  type BeforeCommitPublish,
  type CommitExecutionResult,
  CommitService,
} from '../commit/commit-service.js';
import { type Disposable, EventSource } from '../events/events.js';
import { MemoryWorkspaceStorage } from '../persistence/memory-workspace-storage.js';
import type { WorkspaceSnapshot, WorkspaceStorage } from '../persistence/workspace-storage.js';
import { type FileStat, RepositoryReader } from '../repository/repository-reader.js';
import { SerialExecutor } from '../util/serial-executor.js';
import type { WorkingTreeChange } from '../working-tree/change.js';
import { validateAdapterContract } from './adapter-contract.js';
import { type RemoteHeadRefreshResult, WorkspaceBranchService } from './branch-service.js';
import { BranchWorkspaces } from './branch-workspaces.js';

/** Identifies the selected branch and pinned base after a workspace state transition. */
export interface WorkspaceChangedEvent {
  readonly branch: BranchName;
  readonly baseRevision: RevisionId;
}

type PendingCommitPublication = NonNullable<WorkspaceSnapshot['pendingCommitPublication']>;

/**
 * Public façade for one editable remote repository workspace.
 *
 * The façade coordinates branch-local working trees, persistence, immutable repository reads, and
 * commit-and-publish operations. Domain behavior remains in the corresponding services so callers
 * have one stable API without coupling UI integrations to those internal collaborators.
 */
export class RemotishWorkspace {
  private readonly events = new EventSource<WorkspaceChangedEvent>();
  private readonly mutations = new SerialExecutor();
  private readonly commitService: CommitService;
  private readonly branchService: WorkspaceBranchService;
  private pendingCommitPublication: PendingCommitPublication | undefined;

  private constructor(
    private readonly adapter: RemotishAdapter,
    readonly repositoryInfo: RepositoryInfo,
    private readonly branches: BranchWorkspaces,
    private readonly storage: WorkspaceStorage,
    pendingCommitPublication?: PendingCommitPublication,
  ) {
    this.commitService = new CommitService(adapter);
    this.branchService = new WorkspaceBranchService(adapter, branches);
    this.pendingCommitPublication = pendingCommitPublication;
  }

  static async open(
    adapter: RemotishAdapter,
    storage: WorkspaceStorage = new MemoryWorkspaceStorage(),
  ): Promise<RemotishWorkspace> {
    validateAdapterContract(adapter);
    const repositoryInfo = await adapter.getRepository();
    const reader = new RepositoryReader(adapter);
    const persisted = await storage.load(repositoryInfo.id);
    const branches = await BranchWorkspaces.create(
      adapter,
      reader,
      repositoryInfo.defaultBranch,
      persisted,
    );
    const workspace = new RemotishWorkspace(
      adapter,
      repositoryInfo,
      branches,
      storage,
      persisted?.pendingCommitPublication,
    );
    await workspace.recoverPendingCommitPublication();
    return workspace;
  }

  get capabilities(): RemotishCapabilities {
    return this.adapter.capabilities;
  }

  get branch(): BranchName {
    return this.branches.selectedBranch;
  }

  get baseRevision(): RevisionId {
    return this.branches.current.baseRevision;
  }

  get hasChanges(): boolean {
    return this.branches.current.hasChanges;
  }

  /** Durable publication state that still requires recovery before mutation. */
  get pendingPublication(): WorkspaceSnapshot['pendingCommitPublication'] {
    return this.pendingCommitPublication ? { ...this.pendingCommitPublication } : undefined;
  }

  onDidChange(listener: (event: WorkspaceChangedEvent) => void): Disposable {
    return this.events.on(listener);
  }

  stat(path: RepoPath): Promise<FileStat> {
    return this.branches.current.stat(path);
  }

  readDirectory(path: RepoPath): Promise<readonly DirectoryEntry[]> {
    return this.branches.current.readDirectory(path);
  }

  readFile(path: RepoPath): Promise<Uint8Array> {
    return this.branches.current.readFile(path);
  }

  readBaseFile(path: RepoPath): Promise<Uint8Array> {
    return this.branches.current.readBaseFile(path);
  }

  statRevision(revision: RevisionId, path: RepoPath): Promise<FileStat> {
    return this.branches.current.statRevision(revision, path);
  }

  readRevisionDirectory(revision: RevisionId, path: RepoPath): Promise<readonly DirectoryEntry[]> {
    return this.branches.current.readRevisionDirectory(revision, path);
  }

  readRevisionFile(revision: RevisionId, path: RepoPath): Promise<Uint8Array> {
    return this.branches.current.readRevisionFile(revision, path);
  }

  writeFile(
    path: RepoPath,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    return this.mutate(async () => {
      this.requireWritable();
      await this.branches.current.writeFile(path, content, options);
    });
  }

  createDirectory(path: RepoPath): Promise<void> {
    return this.mutate(async () => {
      this.requireWritable();
      await this.branches.current.createDirectory(path);
    });
  }

  delete(path: RepoPath, recursive: boolean): Promise<void> {
    return this.mutate(async () => {
      this.requireWritable();
      await this.branches.current.delete(path, recursive);
    });
  }

  rename(source: RepoPath, target: RepoPath, overwrite: boolean): Promise<void> {
    return this.mutate(async () => {
      this.requireWritable();
      await this.branches.current.rename(source, target, overwrite);
    });
  }

  getChanges(): Promise<readonly WorkingTreeChange[]> {
    return this.branches.current.getChanges();
  }

  revert(
    path: RepoPath,
    expectedState?: Readonly<{ branch: BranchName; baseRevision: RevisionId }>,
  ): Promise<void> {
    return this.mutate(async () => {
      this.requireExpectedState(expectedState);
      await this.branches.current.revert(path);
    });
  }

  revertAll(
    expectedState?: Readonly<{ branch: BranchName; baseRevision: RevisionId }>,
  ): Promise<void> {
    return this.mutate(async () => {
      this.requireExpectedState(expectedState);
      await this.branches.current.revertAll();
    });
  }

  commitAndPush(
    message: string,
    selectedPaths?: readonly RepoPath[],
    expectedState?: Readonly<{ branch: BranchName; baseRevision: RevisionId }>,
  ): Promise<CommitResult> {
    return this.mutateCommit((beforePublish, afterPublish) => {
      this.requireExpectedState(expectedState);
      return this.commitService.commitAndPush(
        this.branch,
        this.branches.current,
        message,
        selectedPaths,
        beforePublish,
        afterPublish,
      );
    });
  }

  commitAndPushForceWithLease(
    message: string,
    expectedRevision: RevisionId,
    selectedPaths?: readonly RepoPath[],
    expectedState?: Readonly<{ branch: BranchName; baseRevision: RevisionId }>,
  ): Promise<CommitResult> {
    return this.mutateCommit((beforePublish, afterPublish) => {
      this.requireExpectedState(expectedState);
      return this.commitService.commitAndPushForceWithLease(
        this.branch,
        this.branches.current,
        message,
        expectedRevision,
        selectedPaths,
        beforePublish,
        afterPublish,
      );
    });
  }

  amendAndPushForceWithLease(
    message: string,
    selectedPaths?: readonly RepoPath[],
    expectedState?: Readonly<{ branch: BranchName; baseRevision: RevisionId }>,
  ): Promise<CommitResult> {
    return this.mutateCommit((beforePublish, afterPublish) => {
      this.requireExpectedState(expectedState);
      return this.commitService.amendAndPushForceWithLease(
        this.branch,
        this.branches.current,
        message,
        selectedPaths,
        beforePublish,
        afterPublish,
      );
    });
  }

  switchBranch(branch: BranchName): Promise<void> {
    return this.mutate(async () => {
      await this.branchService.switchTo(branch);
    });
  }

  listBranches(options?: RemoteRequestOptions): Promise<readonly Branch[]> {
    return this.adapter.getBranches(options);
  }

  getCommits(request: CommitQuery, options?: RemoteRequestOptions): Promise<CommitPage> {
    return this.adapter.getCommits(request, options);
  }

  getCommitChanges(
    revision: RevisionId,
    options?: RemoteRequestOptions,
  ): Promise<readonly CommitChange[]> {
    return this.adapter.getCommitChanges(revision, options);
  }

  refreshRemoteHead(): Promise<RemoteHeadRefreshResult> {
    return this.mutations.run(() => {
      this.requireNoPendingCommitPublication();
      return this.runLocalMutation(
        () => this.branchService.refresh(),
        (result) => result.status === 'updated',
      );
    });
  }

  createBranch(
    name: BranchName,
    switchTo = true,
    expectedState?: Readonly<{ branch: BranchName; baseRevision: RevisionId }>,
  ): Promise<Branch> {
    return this.mutateRemoteWithResult(() => {
      this.requireExpectedState(expectedState);
      return this.branchService.create(name, switchTo);
    });
  }

  deleteBranch(name: BranchName): Promise<void> {
    return this.mutateRemote(async () => {
      await this.branchService.delete(name);
    });
  }

  persist(): Promise<void> {
    return this.mutations.run(() => this.saveSnapshot());
  }

  /**
   * Resolves a publication whose outcome could not be proven automatically.
   *
   * Use `not-published` only after independently establishing that no publication occurred.
   * Otherwise provide the exact revision that was published.
   */
  resolvePendingCommitPublication(
    resolution: 'not-published' | Readonly<{ publishedRevision: RevisionId }>,
  ): Promise<void> {
    return this.mutations.run(async () => {
      const pending = this.pendingCommitPublication;
      if (!pending) {
        return;
      }

      if (resolution === 'not-published') {
        if (pending.phase === 'published') {
          throw new RemotishError(
            'INVALID_REQUEST',
            `Publication ${pending.publishedRevision} is already known to have succeeded.`,
          );
        }
        this.pendingCommitPublication = undefined;
        try {
          await this.saveSnapshot();
        } catch (error) {
          this.pendingCommitPublication = pending;
          throw error;
        }
        this.emitChanged();
        return;
      }

      const publishedRevision = resolution.publishedRevision;
      if (!publishedRevision.trim()) {
        throw new RemotishError(
          'INVALID_REQUEST',
          'Published revision is required to resolve publication recovery.',
        );
      }
      if (pending.phase === 'published' && pending.publishedRevision !== publishedRevision) {
        throw new RemotishError(
          'INVALID_REQUEST',
          `Pending publication is ${pending.publishedRevision}, not ${publishedRevision}.`,
        );
      }

      const snapshot = this.branches.snapshot();
      try {
        await this.branches.current.acceptPartiallyPublishedRevision(publishedRevision);
        this.pendingCommitPublication = undefined;
        await this.saveSnapshot();
      } catch (error) {
        this.branches.restore(snapshot);
        this.pendingCommitPublication = pending;
        throw error;
      }
      this.emitChanged();
    });
  }

  private requireWritable(): void {
    if (!this.capabilities.commits) {
      throw new RemotishError('FORBIDDEN', 'This repository is read-only.');
    }
  }

  private requireExpectedState(
    expectedState: Readonly<{ branch: BranchName; baseRevision: RevisionId }> | undefined,
  ): void {
    if (!expectedState) {
      return;
    }
    if (this.branch !== expectedState.branch || this.baseRevision !== expectedState.baseRevision) {
      throw new RemotishError(
        'INVALID_REQUEST',
        `Workspace changed from ${expectedState.branch}@${expectedState.baseRevision} to ${this.branch}@${this.baseRevision}. Retry the operation.`,
      );
    }
  }

  private requireNoPendingCommitPublication(): void {
    const pending = this.pendingCommitPublication;
    if (!pending) {
      return;
    }
    const message =
      pending.phase === 'prepared'
        ? 'A previous commit publication has an uncertain outcome. ' +
          'Resolve the pending publication explicitly before mutating the workspace.'
        : 'A previous commit was published, but local reconciliation is incomplete. ' +
          'Reopen the workspace to retry recovery, or resolve it explicitly.';
    throw new RemotishError('INVALID_REQUEST', message);
  }

  private mutate(operation: () => Promise<void>): Promise<void> {
    return this.mutations.run(() => {
      this.requireNoPendingCommitPublication();
      return this.runLocalMutation(operation);
    });
  }

  private mutateCommit(
    operation: (
      beforePublish: BeforeCommitPublish,
      afterPublish: AfterCommitPublish,
    ) => Promise<CommitExecutionResult>,
  ): Promise<CommitResult> {
    return this.mutations.run(async () => {
      this.requireNoPendingCommitPublication();
      const beforePublish: BeforeCommitPublish = async (request) => {
        this.pendingCommitPublication = {
          phase: 'prepared',
          branch: request.branch,
          expectedRemoteRevision:
            request.push.mode === 'normal' ? request.baseRevision : request.push.expectedRevision,
        };
        try {
          await this.saveSnapshot();
        } catch (error) {
          this.pendingCommitPublication = undefined;
          throw error;
        }
      };
      const afterPublish: AfterCommitPublish = async (result) => {
        const prepared = this.pendingCommitPublication;
        if (prepared?.phase !== 'prepared') {
          return;
        }
        this.pendingCommitPublication = {
          ...prepared,
          phase: 'published',
          publishedRevision: result.revision,
        };
        try {
          await this.saveSnapshot();
        } catch {
          // The exact publication revision remains known in memory for this session.
        }
      };

      const execution = await operation(beforePublish, afterPublish);
      const { result } = execution;
      if (result.status === 'success') {
        if (execution.reconciliation === 'settled') {
          this.pendingCommitPublication = undefined;
          await this.changedAfterRemoteSuccess();
        } else {
          try {
            await this.saveSnapshot();
          } catch {
            // Keep the in-memory published journal even when persistence remains unavailable.
          }
          this.emitChanged();
        }
      } else if (this.pendingCommitPublication) {
        this.pendingCommitPublication = undefined;
        await this.saveSnapshot();
      }
      return result;
    });
  }

  private mutateRemote(operation: () => Promise<void>): Promise<void> {
    return this.mutations.run(async () => {
      this.requireNoPendingCommitPublication();
      await operation();
      await this.changedAfterRemoteSuccess();
    });
  }

  private mutateRemoteWithResult<T>(operation: () => Promise<T>): Promise<T> {
    return this.mutations.run(async () => {
      this.requireNoPendingCommitPublication();
      const result = await operation();
      await this.changedAfterRemoteSuccess();
      return result;
    });
  }

  private async runLocalMutation<T>(
    operation: () => Promise<T>,
    didChange: (result: T) => boolean = () => true,
  ): Promise<T> {
    const snapshot = this.branches.snapshot();
    try {
      const result = await operation();
      if (didChange(result)) {
        await this.changed();
      }
      return result;
    } catch (error) {
      this.branches.restore(snapshot);
      throw error;
    }
  }

  private async changed(): Promise<void> {
    await this.saveSnapshot();
    this.emitChanged();
  }

  private async changedAfterRemoteSuccess(): Promise<void> {
    try {
      await this.saveSnapshot();
    } catch {
      // The remote mutation is already published and cannot be rolled back safely.
    }
    this.emitChanged();
  }

  private async recoverPendingCommitPublication(): Promise<void> {
    const pending = this.pendingCommitPublication;
    if (!pending) {
      return;
    }
    if (this.branch !== pending.branch) {
      throw new RemotishError(
        'INVALID_REQUEST',
        `Persisted publication journal targets ${pending.branch}, but ${this.branch} is selected.`,
      );
    }

    if (pending.phase === 'prepared') {
      let remote: Branch | undefined;
      try {
        remote = (await this.adapter.getBranches()).find(
          (candidate) => candidate.name === pending.branch,
        );
      } catch {
        return;
      }
      if (!remote || remote.revision !== pending.expectedRemoteRevision) {
        return;
      }
      this.pendingCommitPublication = undefined;
    } else {
      try {
        await this.branches.current.acceptPartiallyPublishedRevision(pending.publishedRevision);
      } catch {
        return;
      }
      this.pendingCommitPublication = undefined;
    }

    try {
      await this.saveSnapshot();
    } catch {
      // Recovery is idempotent; a persisted journal can be reconciled again on the next open.
    }
  }

  private emitChanged(): void {
    this.events.emit({ branch: this.branch, baseRevision: this.baseRevision });
  }

  private saveSnapshot(): Promise<void> {
    const snapshot = this.branches.snapshot();
    return this.storage.save(
      this.repositoryInfo.id,
      this.pendingCommitPublication
        ? { ...snapshot, pendingCommitPublication: { ...this.pendingCommitPublication } }
        : snapshot,
    );
  }
}
