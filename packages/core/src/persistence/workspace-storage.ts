import type { BranchName, RepositoryId, RevisionId } from '@remotish/adapter-sdk';
import type { OverlaySnapshot } from '../overlay/overlay.js';

/** Persisted pinned base and working-overlay state for one branch. */
export interface BranchWorkspaceSnapshot {
  readonly baseRevision: RevisionId;
  readonly overlay: OverlaySnapshot;
}

/** Persisted selected branch plus all branch-local workspace states for one repository. */
export interface WorkspaceSnapshot {
  readonly version: 1;
  readonly selectedBranch: BranchName;
  readonly branches: Readonly<Record<BranchName, BranchWorkspaceSnapshot>>;
}

/** Host-provided persistence boundary for loading and saving repository workspace state. */
export interface WorkspaceStorage {
  load(repositoryId: RepositoryId): Promise<WorkspaceSnapshot | undefined>;
  save(repositoryId: RepositoryId, snapshot: WorkspaceSnapshot): Promise<void>;
  delete(repositoryId: RepositoryId): Promise<void>;
}
