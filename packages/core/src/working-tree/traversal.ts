import type { DirectoryEntry, RepoPath } from '@remotish/adapter-sdk';
import type { FileStat } from '../repository/repository-reader.js';
import { normalizePath } from '../util/path.js';
import { TraversalBudget } from '../util/traversal-budget.js';

/** Read-only tree operations required by working-tree mutation and change computation. */
export interface TreeView {
  stat(path: RepoPath): Promise<FileStat>;
  readDirectory(path: RepoPath): Promise<readonly DirectoryEntry[]>;
}

export async function listVisibleFiles(
  view: TreeView,
  path: RepoPath,
): Promise<readonly RepoPath[]> {
  const normalized = normalizePath(path);
  const stat = await view.stat(normalized);
  if (stat.type === 'file') {
    return [normalized];
  }

  const result: string[] = [];
  const budget = new TraversalBudget();
  const walk = async (directory: RepoPath, depth: number): Promise<void> => {
    budget.enterDirectory(directory, depth);
    for (const entry of await view.readDirectory(directory)) {
      budget.visit(entry.path);
      if (entry.type === 'file') {
        result.push(entry.path);
      } else {
        await walk(entry.path, depth + 1);
      }
    }
  };
  await walk(normalized, 0);
  return result;
}

export async function listVisibleDirectories(
  view: TreeView,
  path: RepoPath,
): Promise<readonly RepoPath[]> {
  const result: string[] = [];
  const budget = new TraversalBudget();
  const walk = async (directory: RepoPath, depth: number): Promise<void> => {
    budget.enterDirectory(directory, depth);
    for (const entry of await view.readDirectory(directory)) {
      budget.visit(entry.path);
      if (entry.type === 'directory') {
        result.push(entry.path);
        await walk(entry.path, depth + 1);
      }
    }
  };
  await walk(normalizePath(path), 0);
  return result;
}
