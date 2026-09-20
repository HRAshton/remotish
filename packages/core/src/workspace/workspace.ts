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
import { type BeforeCommitPublish, CommitService } from '../commit/commit-service.js';
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
    return this.mutateCommit((beforePublish) => {
      this.requireExpectedState(expectedState);
      return this.commitService.commitAndPush(
        this.branch,
        this.branches.current,
        message,
        selectedPaths,
        beforePublish,
      );
    });
  }

  commitAndPushForceWithLease(
    message: string,
    expectedRevision: RevisionId,
    selectedPaths?: readonly RepoPath[],
    expectedState?: Readonly<{ branch: BranchName; baseRevision: RevisionId }>,
  ): Promise<CommitResult> {
    return this.mutateCommit((beforePublish) => {
      this.requireExpectedState(expectedState);
      return this.commitService.commitAndPushForceWithLease(
        this.branch,
        this.branches.current,
        message,
        expectedRevision,
        selectedPaths,
        beforePublish,
      );
    });
  }

  amendAndPushForceWithLease(
    message: string,
    selectedPaths?: readonly RepoPath[],
    expectedState?: Readonly<{ branch: BranchName; baseRevision: RevisionId }>,
  ): Promise<CommitResult> {
    return this.mutateCommit((beforePublish) => {
      this.requireExpectedState(expectedState);
      return this.commitService.amendAndPushForceWithLease(
        this.branch,
        this.branches.current,
        message,
        selectedPaths,
        beforePublish,
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
    if (!this.pendingCommitPublication) {
      return;
    }
    throw new RemotishError(
      'INVALID_REQUEST',
      'A previous commit publication has an uncertain outcome. Reopen the workspace to reconcile it.',
    );
  }

  private mutate(operation: () => Promise<void>): Promise<void> {
    return this.mutations.run(() => {
      this.requireNoPendingCommitPublication();
      return this.runLocalMutation(operation);
    });
  }

  private mutateCommit(
    operation: (beforePublish: BeforeCommitPublish) => Promise<CommitResult>,
  ): Promise<CommitResult> {
    return this.mutations.run(async () => {
      this.requireNoPendingCommitPublication();
      const beforePublish: BeforeCommitPublish = async (request) => {
        this.pendingCommitPublication = {
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

      const result = await operation(beforePublish);
      if (result.status === 'success') {
        this.pendingCommitPublication = undefined;
        await this.changedAfterRemoteSuccess();
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

    const remote = (await this.adapter.getBranches()).find(
      (candidate) => candidate.name === pending.branch,
    );
    if (!remote) {
      throw new RemotishError(
        'NOT_FOUND',
        `Cannot recover publication state because branch ${pending.branch} no longer exists.`,
      );
    }
    if (remote.revision !== pending.expectedRemoteRevision) {
      await this.branches.current.acceptPartiallyPublishedRevision(remote.revision);
    }

    this.pendingCommitPublication = undefined;
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
