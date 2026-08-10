import { type Change, type CommitChange, RemotishError } from '@remotish/adapter-sdk';
import { normalizePath, parentPath } from './path.js';

/** Apply changes. */
export function applyChanges(files: Map<string, Uint8Array>, changes: readonly Change[]): void {
  const seen = new Set<string>();
  for (const change of changes) {
    const path = normalizePath(change.path);
    if (!path) {
      throw new RemotishError('INVALID_REQUEST', 'Repository root cannot be changed as a file.');
    }
    if (seen.has(path)) {
      throw new RemotishError('INVALID_REQUEST', `Duplicate change for ${path}.`);
    }
    seen.add(path);

    if (change.type === 'delete') {
      if (!files.has(path)) {
        throw new RemotishError('INVALID_REQUEST', `Cannot delete missing file ${path}.`);
      }
      files.delete(path);
      continue;
    }

    const exists = files.has(path);
    if (change.type === 'add' && exists) {
      throw new RemotishError('INVALID_REQUEST', `Cannot add existing file ${path}.`);
    }
    if (change.type === 'modify' && !exists) {
      throw new RemotishError('INVALID_REQUEST', `Cannot modify missing file ${path}.`);
    }
    files.set(path, change.content.slice());
  }

  for (const file of files.keys()) {
    const parent = parentPath(file);
    if (parent && files.has(parent)) {
      throw new RemotishError('INVALID_REQUEST', `${parent} cannot be both a file and directory.`);
    }
  }
}

/** Diff files. */
export function diffFiles(
  before: Map<string, Uint8Array>,
  after: Map<string, Uint8Array>,
): CommitChange[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  const changes: CommitChange[] = [];
  for (const path of [...paths].sort()) {
    const left = before.get(path);
    const right = after.get(path);
    if (!left && right) {
      changes.push({ type: 'added', path });
    } else if (left && !right) {
      changes.push({ type: 'deleted', path });
    } else if (left && right && !equalBytes(left, right)) {
      changes.push({ type: 'modified', path });
    }
  }
  return changes;
}

/** Clone files. */
export function cloneFiles(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  return new Map([...files].map(([path, content]) => [path, content.slice()]));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
