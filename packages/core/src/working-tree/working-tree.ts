import {
  type Change,
  type DirectoryEntry,
  RemotishError,
  type RepoPath,
  type RevisionId,
} from '@remotish/adapter-sdk';
import { Overlay, type OverlaySnapshot } from './overlay.js';
import type { FileStat, RepositoryReader } from '../repository/repository-reader.js';
import { baseName, normalizePath } from '../util/path.js';
import type { WorkingTreeChange } from './change.js';
import { buildCommitChanges, getWorkingTreeChanges } from './change-set.js';
import { WorkingTreeMutations } from './mutation-service.js';
import { rebaseOverlayAfterPartialPublish } from './published-revision.js';

/** Serializable pinned base plus overlay for one branch-local working tree. */
export interface WorkingTreeSnapshot {
  readonly baseRevision: RevisionId;
  readonly overlay: OverlaySnapshot;
}

/** Combines an immutable base revision with a mutable overlay to expose the visible working tree. */
export class WorkingTree {
  private readonly overlay: Overlay;
  private readonly mutations: WorkingTreeMutations;
  private _baseRevision: RevisionId;

  constructor(
    readonly repository: RepositoryReader,
    baseRevision: RevisionId,
    snapshot?: OverlaySnapshot,
  ) {
    this._baseRevision = baseRevision;
    this.overlay = Overlay.fromSnapshot(snapshot);
    this.mutations = new WorkingTreeMutations(
      repository,
      this.overlay,
      () => this._baseRevision,
      this,
    );
  }

  get baseRevision(): RevisionId {
    return this._baseRevision;
  }

  get hasChanges(): boolean {
    return !this.overlay.isEmpty;
  }

  async stat(path: RepoPath): Promise<FileStat> {
    const normalized = normalizePath(path);
    if (!normalized) {
      return { type: 'directory', size: 0 };
    }
    if (this.overlay.isDeleted(normalized)) {
      throw notFound(normalized);
    }
    const overlayFile = this.overlay.getFile(normalized);
    if (overlayFile) {
      return { type: 'file', size: overlayFile.byteLength };
    }
    if (this.overlay.hasDirectory(normalized)) {
      return { type: 'directory', size: 0 };
    }
    return this.repository.stat(this._baseRevision, normalized);
  }

  async readFile(path: RepoPath): Promise<Uint8Array> {
    const normalized = normalizePath(path);
    if (this.overlay.isDeleted(normalized)) {
      throw notFound(normalized);
    }
    const overlay = this.overlay.getFile(normalized);
    if (overlay) {
      return overlay;
    }
    return this.repository.readFile(this._baseRevision, normalized);
  }

  readBaseFile(path: RepoPath): Promise<Uint8Array> {
    return this.readRevisionFile(this._baseRevision, path);
  }

  statRevision(revision: RevisionId, path: RepoPath): Promise<FileStat> {
    return this.repository.stat(revision, normalizePath(path));
  }

  readRevisionDirectory(revision: RevisionId, path: RepoPath): Promise<readonly DirectoryEntry[]> {
    return this.repository.readDirectory(revision, normalizePath(path));
  }

  readRevisionFile(revision: RevisionId, path: RepoPath): Promise<Uint8Array> {
    return this.repository.readFile(revision, normalizePath(path));
  }

  async readDirectory(path: RepoPath): Promise<readonly DirectoryEntry[]> {
    const normalized = normalizePath(path);
    const stat = await this.stat(normalized);
    if (stat.type !== 'directory') {
      throw new RemotishError('INVALID_REQUEST', `${normalized} is not a directory.`);
    }

    const entries = new Map<string, DirectoryEntry>();
    const base = await this.repository.tryStat(this._baseRevision, normalized);
    if (base?.type === 'directory') {
      for (const entry of await this.repository.readDirectory(this._baseRevision, normalized)) {
        if (!this.overlay.isDeleted(entry.path)) {
          entries.set(entry.name, { ...entry });
        }
      }
    }

    for (const child of this.overlay.directChildren(normalized)) {
      const name = baseName(child.path);
      entries.set(name, {
        name,
        path: child.path,
        type: child.type,
        ...(child.type === 'file' ? { size: child.size } : {}),
      });
    }
    return [...entries.values()].sort(compareDirectoryEntries);
  }

  writeFile(
    path: RepoPath,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    return this.mutations.writeFile(path, content, options);
  }

  createDirectory(path: RepoPath): Promise<void> {
    return this.mutations.createDirectory(path);
  }

  delete(path: RepoPath, recursive: boolean): Promise<void> {
    return this.mutations.delete(path, recursive);
  }

  rename(source: RepoPath, target: RepoPath, overwrite: boolean): Promise<void> {
    return this.mutations.rename(source, target, overwrite);
  }

  getChanges(): Promise<readonly WorkingTreeChange[]> {
    return getWorkingTreeChanges(this.repository, this._baseRevision, this.overlay);
  }

  revert(path: RepoPath): Promise<void> {
    return this.mutations.revert(path);
  }

  revertAll(): Promise<void> {
    return this.mutations.revertAll();
  }

  buildCommitChanges(selectedPaths?: readonly RepoPath[]): Promise<readonly Change[]> {
    return buildCommitChanges(this.repository, this._baseRevision, this.overlay, selectedPaths);
  }

  acceptPublishedRevision(revision: RevisionId): void {
    this._baseRevision = revision;
    this.overlay.clear();
  }

  async acceptPartiallyPublishedRevision(revision: RevisionId): Promise<void> {
    this._baseRevision = revision;
    await rebaseOverlayAfterPartialPublish(this.repository, revision, this.overlay);
  }

  rebindCleanBase(revision: RevisionId): void {
    if (this.hasChanges) {
      throw new RemotishError('INVALID_REQUEST', 'Cannot rebind a working tree that has changes.');
    }
    this._baseRevision = revision;
  }

  snapshot(): WorkingTreeSnapshot {
    return { baseRevision: this._baseRevision, overlay: this.overlay.snapshot() };
  }
}

function notFound(path: RepoPath): RemotishError {
  return new RemotishError('NOT_FOUND', `Path ${path} does not exist.`);
}

function compareDirectoryEntries(left: DirectoryEntry, right: DirectoryEntry): number {
  if (left.type !== right.type) {
    return left.type === 'directory' ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}
