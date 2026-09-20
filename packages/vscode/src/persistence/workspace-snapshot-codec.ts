import type { WorkspaceSnapshot } from '@remotish/core';

interface StoredOverlayFile {
  readonly path: string;
  readonly contentBase64: string;
}

interface StoredRenameSnapshot {
  readonly from: string;
  readonly to: string;
}

type StoredPendingCommitPublication =
  | {
      readonly phase: 'prepared';
      readonly branch: string;
      readonly expectedRemoteRevision: string;
    }
  | {
      readonly phase: 'published';
      readonly branch: string;
      readonly expectedRemoteRevision: string;
      readonly publishedRevision: string;
    };

interface StoredBranchWorkspaceSnapshot {
  readonly baseRevision: string;
  readonly overlay: {
    readonly files: readonly StoredOverlayFile[];
    readonly directories: readonly string[];
    readonly deletedPaths: readonly string[];
    readonly renames: readonly StoredRenameSnapshot[];
  };
}

/** JSON/base64 representation used by Memento-backed persistence for small workspace snapshots. */
export interface StoredWorkspaceSnapshot {
  readonly version: 1;
  readonly selectedBranch: string;
  readonly branches: Readonly<Record<string, StoredBranchWorkspaceSnapshot>>;
  readonly pendingCommitPublication?: StoredPendingCommitPublication;
}

/** Encodes binary overlay files as base64 for Memento-compatible JSON storage. */
export function encodeWorkspaceSnapshot(snapshot: WorkspaceSnapshot): StoredWorkspaceSnapshot {
  const branches = Object.create(null) as Record<string, StoredBranchWorkspaceSnapshot>;
  for (const [name, branch] of Object.entries(snapshot.branches)) {
    branches[name] = {
      baseRevision: branch.baseRevision,
      overlay: {
        files: branch.overlay.files.map((file) => ({
          path: file.path,
          contentBase64: encodeBase64(file.content),
        })),
        directories: [...branch.overlay.directories],
        deletedPaths: [...branch.overlay.deletedPaths],
        renames: branch.overlay.renames.map((rename) => ({ ...rename })),
      },
    };
  }
  return {
    version: 1,
    selectedBranch: snapshot.selectedBranch,
    branches,
    ...(snapshot.pendingCommitPublication
      ? { pendingCommitPublication: { ...snapshot.pendingCommitPublication } }
      : {}),
  };
}

/** Validates and restores persisted JSON/base64 data to the core workspace representation. */
export function decodeWorkspaceSnapshot(value: unknown): WorkspaceSnapshot {
  const stored = requireStoredWorkspaceSnapshot(value);
  const branches = Object.create(null) as Record<string, WorkspaceSnapshot['branches'][string]>;
  for (const [name, branch] of Object.entries(stored.branches)) {
    branches[name] = {
      baseRevision: branch.baseRevision,
      overlay: {
        files: branch.overlay.files.map((file) => ({
          path: file.path,
          content: decodeBase64(file.contentBase64, file.path),
        })),
        directories: [...branch.overlay.directories],
        deletedPaths: [...branch.overlay.deletedPaths],
        renames: branch.overlay.renames.map((rename) => ({ ...rename })),
      },
    };
  }
  return {
    version: 1,
    selectedBranch: stored.selectedBranch,
    branches,
    ...(stored.pendingCommitPublication
      ? { pendingCommitPublication: { ...stored.pendingCommitPublication } }
      : {}),
  };
}

function requireStoredWorkspaceSnapshot(value: unknown): StoredWorkspaceSnapshot {
  const snapshot = requireRecord(value, 'workspace snapshot');
  if (snapshot.version !== 1) {
    throw invalidSnapshot(`unsupported version ${String(snapshot.version)}`);
  }
  const selectedBranch = requireString(snapshot.selectedBranch, 'selectedBranch');
  const storedBranches = requireRecord(snapshot.branches, 'branches');
  const branches = Object.create(null) as Record<string, StoredBranchWorkspaceSnapshot>;
  const pendingCommitPublication =
    snapshot.pendingCommitPublication === undefined
      ? undefined
      : requirePendingCommitPublication(snapshot.pendingCommitPublication);

  for (const [name, value] of Object.entries(storedBranches)) {
    const branch = requireRecord(value, `branches.${name}`);
    const overlay = requireRecord(branch.overlay, `branches.${name}.overlay`);
    branches[name] = {
      baseRevision: requireString(branch.baseRevision, `branches.${name}.baseRevision`),
      overlay: {
        files: requireArray(overlay.files, `branches.${name}.overlay.files`).map((file, index) => {
          const item = requireRecord(file, `branches.${name}.overlay.files[${index}]`);
          return {
            path: requireString(item.path, `branches.${name}.overlay.files[${index}].path`),
            contentBase64: requireString(
              item.contentBase64,
              `branches.${name}.overlay.files[${index}].contentBase64`,
            ),
          };
        }),
        directories: requireStringArray(
          overlay.directories,
          `branches.${name}.overlay.directories`,
        ),
        deletedPaths: requireStringArray(
          overlay.deletedPaths,
          `branches.${name}.overlay.deletedPaths`,
        ),
        renames: requireArray(overlay.renames, `branches.${name}.overlay.renames`).map(
          (rename, index) => {
            const item = requireRecord(rename, `branches.${name}.overlay.renames[${index}]`);
            return {
              from: requireString(item.from, `branches.${name}.overlay.renames[${index}].from`),
              to: requireString(item.to, `branches.${name}.overlay.renames[${index}].to`),
            };
          },
        ),
      },
    };
  }

  if (!Object.hasOwn(branches, selectedBranch)) {
    throw invalidSnapshot(`selected branch ${selectedBranch} is not present in branches`);
  }
  if (pendingCommitPublication && pendingCommitPublication.branch !== selectedBranch) {
    throw invalidSnapshot('pending publication branch must be the selected branch');
  }
  return {
    version: 1,
    selectedBranch,
    branches,
    ...(pendingCommitPublication ? { pendingCommitPublication } : {}),
  };
}

function requirePendingCommitPublication(value: unknown): StoredPendingCommitPublication {
  const pending = requireRecord(value, 'pendingCommitPublication');
  const branch = requireString(pending.branch, 'pendingCommitPublication.branch');
  const expectedRemoteRevision = requireString(
    pending.expectedRemoteRevision,
    'pendingCommitPublication.expectedRemoteRevision',
  );
  if (pending.phase === undefined || pending.phase === 'prepared') {
    return { phase: 'prepared', branch, expectedRemoteRevision };
  }
  if (pending.phase === 'published') {
    return {
      phase: 'published',
      branch,
      expectedRemoteRevision,
      publishedRevision: requireString(
        pending.publishedRevision,
        'pendingCommitPublication.publishedRevision',
      ),
    };
  }
  throw invalidSnapshot(`pendingCommitPublication.phase is unsupported: ${String(pending.phase)}`);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidSnapshot(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw invalidSnapshot(`${field} must be an array`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) {
    throw invalidSnapshot(`${field} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  return requireArray(value, field).map((item, index) => requireString(item, `${field}[${index}]`));
}

function invalidSnapshot(detail: string): Error {
  return new Error(`Invalid persisted Remotish workspace: ${detail}.`);
}

function encodeBase64(content: Uint8Array): string {
  let binary = '';
  for (const byte of content) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64(value: string, path: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch (error) {
    throw new Error(`Invalid persisted Remotish workspace: invalid base64 for ${path}.`, {
      cause: error,
    });
  }
  const content = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    content[index] = binary.charCodeAt(index);
  }
  return content;
}
