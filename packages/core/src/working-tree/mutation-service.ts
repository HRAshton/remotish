import { RemotishError, type RepoPath, type RevisionId } from '@remotish/adapter-sdk';
import type { Overlay } from '../overlay/overlay.js';
import type { FileStat, RepositoryReader } from '../repository/repository-reader.js';
import { equalBytes } from '../util/bytes.js';
import { isSameOrChild, normalizePath, parentPath } from '../util/path.js';
import { SerialExecutor } from '../util/serial-executor.js';
import { listVisibleDirectories, listVisibleFiles, type TreeView } from './traversal.js';

interface MutableTreeView extends TreeView {
  readFile(path: RepoPath): Promise<Uint8Array>;
}

/** Applies writes, deletes, renames, and reverts to the overlay while consulting the immutable base. */
export class WorkingTreeMutations {
  private readonly serial = new SerialExecutor();

  constructor(
    private readonly repository: RepositoryReader,
    private readonly overlay: Overlay,
    private readonly baseRevision: () => RevisionId,
    private readonly view: MutableTreeView,
  ) {}

  writeFile(
    path: RepoPath,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    return this.serial.run(async () => {
      const normalized = requireNonRoot(path);
      const current = await this.tryStat(normalized);
      if (!current && !options.create) {
        throw notFound(normalized);
      }
      if (current && !options.overwrite) {
        throw new RemotishError('INVALID_REQUEST', `${normalized} already exists.`);
      }
      if (current?.type === 'directory') {
        throw new RemotishError('INVALID_REQUEST', `${normalized} is a directory.`);
      }
      await this.requireDirectory(parentPath(normalized) ?? '');

      const base = await this.tryReadBase(normalized);
      if (base && equalBytes(base, content)) {
        this.overlay.removeOverlayPath(normalized);
        this.overlay.unmarkDeleted(normalized, true);
      } else {
        this.overlay.setFile(normalized, content);
      }
    });
  }

  createDirectory(path: RepoPath): Promise<void> {
    return this.serial.run(async () => {
      const normalized = requireNonRoot(path);
      if (await this.tryStat(normalized)) {
        throw new RemotishError('INVALID_REQUEST', `${normalized} already exists.`);
      }
      await this.requireDirectory(parentPath(normalized) ?? '');
      this.overlay.setDirectory(normalized);
    });
  }

  delete(path: RepoPath, recursive: boolean): Promise<void> {
    return this.serial.run(() => this.deleteInternal(requireNonRoot(path), recursive));
  }

  rename(source: RepoPath, target: RepoPath, overwrite: boolean): Promise<void> {
    return this.serial.run(async () => {
      const from = requireNonRoot(source);
      const to = requireNonRoot(target);
      if (from === to) {
        return;
      }
      if (isSameOrChild(to, from)) {
        throw new RemotishError('INVALID_REQUEST', 'Cannot move a directory inside itself.');
      }

      const sourceStat = await this.view.stat(from);
      const targetStat = await this.tryStat(to);
      if (targetStat && !overwrite) {
        throw new RemotishError('INVALID_REQUEST', `${to} already exists.`);
      }
      await this.requireDirectory(parentPath(to) ?? '');
      if (targetStat) {
        await this.deleteInternal(to, true);
      }

      if (sourceStat.type === 'file') {
        await this.renameFile(from, to);
        return;
      }
      await this.renameDirectory(from, to);
    });
  }

  revert(path: RepoPath): Promise<void> {
    return this.serial.run(async () => {
      const normalized = normalizePath(path);
      const rename = this.overlay.removeRenameTo(normalized);
      if (rename) {
        this.overlay.removeOverlayPath(rename.to);
        this.overlay.unmarkDeleted(rename.from, true);
        return;
      }
      this.overlay.removeOverlayPath(normalized);
      this.overlay.unmarkDeleted(normalized, true);
    });
  }

  revertAll(): Promise<void> {
    return this.serial.run(async () => this.overlay.clear());
  }

  private async renameFile(from: RepoPath, to: RepoPath): Promise<void> {
    const content = await this.view.readFile(from);
    await this.deleteFileInternal(from);
    this.overlay.setFile(to, content);
    this.overlay.addRename(from, to);
  }

  private async renameDirectory(from: RepoPath, to: RepoPath): Promise<void> {
    const files = await listVisibleFiles(this.view, from);
    const directories = await listVisibleDirectories(this.view, from);
    const contents = new Map<string, Uint8Array>();
    for (const file of files) {
      contents.set(file, await this.view.readFile(file));
    }

    for (const directory of directories) {
      const suffix = directory.slice(from.length);
      this.overlay.setDirectory(`${to}${suffix}`);
    }
    this.overlay.setDirectory(to);
    for (const file of files) {
      const suffix = file.slice(from.length);
      this.overlay.setFile(`${to}${suffix}`, contents.get(file) ?? new Uint8Array());
    }

    await this.deleteInternal(from, true);
    for (const file of files) {
      const suffix = file.slice(from.length);
      this.overlay.addRename(file, `${to}${suffix}`);
    }
  }

  private async deleteInternal(path: RepoPath, recursive: boolean): Promise<void> {
    const stat = await this.view.stat(path);
    if (stat.type === 'file') {
      await this.deleteFileInternal(path);
      return;
    }

    const entries = await this.view.readDirectory(path);
    if (!recursive && entries.length > 0) {
      throw new RemotishError('INVALID_REQUEST', `${path} is not empty.`);
    }

    for (const file of await listVisibleFiles(this.view, path)) {
      await this.deleteFileInternal(file);
    }
    this.overlay.removeOverlayPath(path);
    const base = await this.repository.tryStat(this.baseRevision(), path);
    if (base?.type === 'directory') {
      this.overlay.markDeleted(path);
    }
  }

  private async deleteFileInternal(path: RepoPath): Promise<void> {
    const normalized = normalizePath(path);
    const base = await this.repository.tryStat(this.baseRevision(), normalized);
    this.overlay.removeOverlayPath(normalized);
    if (base?.type === 'file') {
      this.overlay.markDeleted(normalized);
    } else {
      this.overlay.unmarkDeleted(normalized, true);
    }
  }

  private async requireDirectory(path: RepoPath): Promise<void> {
    const stat = await this.view.stat(path);
    if (stat.type !== 'directory') {
      throw new RemotishError('INVALID_REQUEST', `${path} is not a directory.`);
    }
  }

  private async tryStat(path: RepoPath): Promise<FileStat | undefined> {
    try {
      return await this.view.stat(path);
    } catch (error) {
      if (error instanceof RemotishError && error.code === 'NOT_FOUND') {
        return undefined;
      }
      throw error;
    }
  }

  private async tryReadBase(path: RepoPath): Promise<Uint8Array | undefined> {
    const revision = this.baseRevision();
    const stat = await this.repository.tryStat(revision, path);
    if (stat?.type !== 'file') {
      return undefined;
    }
    return this.repository.readFile(revision, path);
  }
}

function requireNonRoot(path: RepoPath): RepoPath {
  const normalized = normalizePath(path);
  if (!normalized) {
    throw new RemotishError('INVALID_REQUEST', 'Repository root cannot be modified directly.');
  }
  return normalized;
}

function notFound(path: RepoPath): RemotishError {
  return new RemotishError('NOT_FOUND', `Path ${path} does not exist.`);
}
