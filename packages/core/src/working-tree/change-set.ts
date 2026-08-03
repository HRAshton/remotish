import type { Change, RepoPath, RevisionId } from '@remotish/adapter-sdk';
import type { Overlay } from './overlay.js';
import type { RepositoryReader } from '../repository/repository-reader.js';
import { cloneBytes, equalBytes } from '../util/bytes.js';
import { normalizePath } from '../util/path.js';
import type { WorkingTreeChange } from './change.js';

export async function getWorkingTreeChanges(
  repository: RepositoryReader,
  baseRevision: RevisionId,
  overlay: Overlay,
): Promise<readonly WorkingTreeChange[]> {
  const changes = new Map<string, WorkingTreeChange>();
  const renames = overlay.listRenames();

  for (const rename of renames) {
    changes.set(rename.to, { type: 'renamed', path: rename.to, originalPath: rename.from });
  }

  for (const file of overlay.listFiles()) {
    if (changes.has(file.path)) {
      continue;
    }
    const base = await tryReadBase(repository, baseRevision, file.path);
    if (!base) {
      changes.set(file.path, { type: 'added', path: file.path });
    } else if (!equalBytes(base, file.content)) {
      changes.set(file.path, { type: 'modified', path: file.path });
    }
  }

  for (const path of await deletedBaseFiles(repository, baseRevision, overlay)) {
    if (renames.some((rename) => rename.from === path)) {
      continue;
    }
    changes.set(path, { type: 'deleted', path });
  }

  return [...changes.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export async function buildCommitChanges(
  repository: RepositoryReader,
  baseRevision: RevisionId,
  overlay: Overlay,
  selectedPaths?: readonly RepoPath[],
): Promise<readonly Change[]> {
  const allChanges = await buildAllCommitChanges(repository, baseRevision, overlay);
  if (selectedPaths === undefined) {
    return allChanges;
  }

  const selected = new Set(selectedPaths.map(normalizePath));
  if (selected.size === 0) {
    return [];
  }

  const selectedCommitPaths = new Set<RepoPath>();
  for (const change of await getWorkingTreeChanges(repository, baseRevision, overlay)) {
    if (!selected.has(change.path)) {
      continue;
    }
    selectedCommitPaths.add(change.path);
    if (change.type === 'renamed') {
      selectedCommitPaths.add(change.originalPath);
    }
  }

  return allChanges.filter((change) => selectedCommitPaths.has(change.path));
}

async function buildAllCommitChanges(
  repository: RepositoryReader,
  baseRevision: RevisionId,
  overlay: Overlay,
): Promise<readonly Change[]> {
  const changes = new Map<string, Change>();

  for (const file of overlay.listFiles()) {
    const base = await tryReadBase(repository, baseRevision, file.path);
    if (!base) {
      changes.set(file.path, { type: 'add', path: file.path, content: cloneBytes(file.content) });
    } else if (!equalBytes(base, file.content)) {
      changes.set(file.path, {
        type: 'modify',
        path: file.path,
        content: cloneBytes(file.content),
      });
    }
  }

  for (const path of await deletedBaseFiles(repository, baseRevision, overlay)) {
    if (!changes.has(path)) {
      changes.set(path, { type: 'delete', path });
    }
  }

  return [...changes.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function deletedBaseFiles(
  repository: RepositoryReader,
  baseRevision: RevisionId,
  overlay: Overlay,
): Promise<readonly RepoPath[]> {
  const result = new Set<string>();
  for (const deleted of overlay.listDeletedPaths()) {
    const stat = await repository.tryStat(baseRevision, deleted);
    if (!stat) {
      continue;
    }
    if (stat.type === 'file') {
      result.add(deleted);
    } else {
      for (const file of await repository.listFilesRecursively(baseRevision, deleted)) {
        result.add(file);
      }
    }
  }
  return [...result].sort();
}

async function tryReadBase(
  repository: RepositoryReader,
  baseRevision: RevisionId,
  path: RepoPath,
): Promise<Uint8Array | undefined> {
  const stat = await repository.tryStat(baseRevision, path);
  if (stat?.type !== 'file') {
    return undefined;
  }
  return repository.readFile(baseRevision, path);
}
