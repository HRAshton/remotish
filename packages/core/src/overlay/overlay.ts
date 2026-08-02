import type { RepoPath } from '@remotish/adapter-sdk';
import { cloneBytes } from '../util/bytes.js';
import { isDirectChild, isSameOrChild, normalizePath } from '../util/path.js';

/** Serialized overlay file content used by workspace persistence. */
export interface OverlayFileSnapshot {
  readonly path: RepoPath;
  readonly content: Uint8Array;
}

/** Records the source and destination of a framework-owned rename. */
export interface RenameSnapshot {
  readonly from: RepoPath;
  readonly to: RepoPath;
}

/** Complete serializable working-overlay state for one branch workspace. */
export interface OverlaySnapshot {
  readonly files: readonly OverlayFileSnapshot[];
  readonly directories: readonly RepoPath[];
  readonly deletedPaths: readonly RepoPath[];
  readonly renames: readonly RenameSnapshot[];
}

/** One direct child materialized from the local overlay. */
export interface OverlayEntry {
  readonly path: RepoPath;
  readonly type: 'file' | 'directory';
  readonly size: number;
}

/**
 * Stores working-tree mutations layered over an immutable base revision.
 *
 * File writes live only in this overlay until publication. Deletions are represented as tombstones,
 * directory markers preserve locally-created directories, and rename records retain presentation
 * metadata while publication still emits ordinary content changes.
 */
export class Overlay {
  private readonly files = new Map<RepoPath, Uint8Array>();
  private readonly directories = new Set<RepoPath>();
  private readonly deletedPaths = new Set<RepoPath>();
  private readonly renames: RenameSnapshot[] = [];

  static fromSnapshot(snapshot?: OverlaySnapshot): Overlay {
    const overlay = new Overlay();
    if (!snapshot) {
      return overlay;
    }
    for (const file of snapshot.files) {
      overlay.files.set(normalizePath(file.path), cloneBytes(file.content));
    }
    for (const directory of snapshot.directories) {
      overlay.directories.add(normalizePath(directory));
    }
    for (const path of snapshot.deletedPaths) {
      overlay.deletedPaths.add(normalizePath(path));
    }
    for (const rename of snapshot.renames) {
      overlay.renames.push({ from: normalizePath(rename.from), to: normalizePath(rename.to) });
    }
    return overlay;
  }

  get isEmpty(): boolean {
    return this.files.size === 0 && this.directories.size === 0 && this.deletedPaths.size === 0;
  }

  getFile(path: RepoPath): Uint8Array | undefined {
    const content = this.files.get(normalizePath(path));
    return content?.slice();
  }

  /** Remove one exact file entry from the overlay. */
  removeFile(path: RepoPath): void {
    this.files.delete(normalizePath(path));
  }

  /** Remove one exact directory marker from the overlay. */
  removeDirectory(path: RepoPath): void {
    this.directories.delete(normalizePath(path));
  }

  hasDirectory(path: RepoPath): boolean {
    return this.directories.has(normalizePath(path));
  }

  setFile(path: RepoPath, content: Uint8Array): void {
    const normalized = normalizePath(path);
    this.files.set(normalized, cloneBytes(content));
    this.directories.delete(normalized);
    this.clearDeletionForRecreatedPath(normalized, false);
  }

  setDirectory(path: RepoPath): void {
    const normalized = normalizePath(path);
    this.directories.add(normalized);
    this.files.delete(normalized);
    this.clearDeletionForRecreatedPath(normalized, true);
  }

  removeOverlayPath(path: RepoPath): void {
    const normalized = normalizePath(path);
    for (const file of [...this.files.keys()]) {
      if (isSameOrChild(file, normalized)) {
        this.files.delete(file);
      }
    }
    for (const directory of [...this.directories]) {
      if (isSameOrChild(directory, normalized)) {
        this.directories.delete(directory);
      }
    }
    for (let index = this.renames.length - 1; index >= 0; index -= 1) {
      const rename = this.renames[index];
      if (
        rename &&
        (isSameOrChild(rename.from, normalized) || isSameOrChild(rename.to, normalized))
      ) {
        this.renames.splice(index, 1);
      }
    }
  }

  markDeleted(path: RepoPath): void {
    const normalized = normalizePath(path);
    this.removeOverlayPath(normalized);
    // Keep child tombstones when a directory is deleted. If that directory is
    // later recreated or one child is reverted, those child tombstones preserve
    // the remaining deletions instead of making the whole base subtree reappear.
    this.deletedPaths.add(normalized);
  }

  unmarkDeleted(path: RepoPath, includeAncestors = false): void {
    const normalized = normalizePath(path);
    for (const deleted of [...this.deletedPaths]) {
      if (deleted === normalized || (includeAncestors && isSameOrChild(normalized, deleted))) {
        this.deletedPaths.delete(deleted);
      }
    }
  }

  isDeleted(path: RepoPath): boolean {
    const normalized = normalizePath(path);
    return [...this.deletedPaths].some((deleted) => isSameOrChild(normalized, deleted));
  }

  addRename(from: RepoPath, to: RepoPath): void {
    const normalizedFrom = normalizePath(from);
    const normalizedTo = normalizePath(to);
    this.renames.push({ from: normalizedFrom, to: normalizedTo });
  }

  removeRenameTo(path: RepoPath): RenameSnapshot | undefined {
    const normalized = normalizePath(path);
    const index = this.renames.findIndex((rename) => rename.to === normalized);
    if (index < 0) {
      return undefined;
    }
    const [rename] = this.renames.splice(index, 1);
    return rename;
  }

  /** Remove one exact rename record from the overlay. */
  removeRename(from: RepoPath, to: RepoPath): void {
    const normalizedFrom = normalizePath(from);
    const normalizedTo = normalizePath(to);
    const index = this.renames.findIndex(
      (rename) => rename.from === normalizedFrom && rename.to === normalizedTo,
    );
    if (index >= 0) {
      this.renames.splice(index, 1);
    }
  }

  listFiles(): readonly OverlayFileSnapshot[] {
    return [...this.files]
      .map(([path, content]) => ({ path, content: content.slice() }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  listDirectories(): readonly RepoPath[] {
    return [...this.directories].sort();
  }

  listDeletedPaths(): readonly RepoPath[] {
    return [...this.deletedPaths].sort();
  }

  listRenames(): readonly RenameSnapshot[] {
    return this.renames.map((rename) => ({ ...rename }));
  }

  directChildren(path: RepoPath): readonly OverlayEntry[] {
    const normalized = normalizePath(path);
    const result = new Map<string, OverlayEntry>();
    for (const [file, content] of this.files) {
      if (isDirectChild(file, normalized) && !this.isDeleted(file)) {
        result.set(file, { path: file, type: 'file', size: content.byteLength });
      }
    }
    for (const directory of this.directories) {
      if (isDirectChild(directory, normalized) && !this.isDeleted(directory)) {
        result.set(directory, { path: directory, type: 'directory', size: 0 });
      }
    }
    return [...result.values()];
  }

  clear(): void {
    this.files.clear();
    this.directories.clear();
    this.deletedPaths.clear();
    this.renames.length = 0;
  }

  snapshot(): OverlaySnapshot {
    return {
      files: this.listFiles(),
      directories: this.listDirectories(),
      deletedPaths: this.listDeletedPaths(),
      renames: this.listRenames(),
    };
  }

  private clearDeletionForRecreatedPath(path: RepoPath, directory: boolean): void {
    if (directory) {
      this.deletedPaths.delete(path);
      return;
    }
    this.unmarkDeleted(path, true);
  }
}
