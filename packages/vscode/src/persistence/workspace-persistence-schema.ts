import type { WorkspaceSnapshot } from '@remotish/core';

interface StoredRenameSnapshot {
  readonly from: string;
  readonly to: string;
}

export type StoredPendingCommitPublication =
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

export interface StoredBranchWorkspaceSnapshot<TFile extends { readonly path: string }> {
  readonly baseRevision: string;
  readonly overlay: {
    readonly files: readonly TFile[];
    readonly directories: readonly string[];
    readonly deletedPaths: readonly string[];
    readonly renames: readonly StoredRenameSnapshot[];
  };
}

export interface StoredWorkspaceSnapshotShape<TFile extends { readonly path: string }> {
  readonly selectedBranch: string;
  readonly branches: Readonly<Record<string, StoredBranchWorkspaceSnapshot<TFile>>>;
  readonly pendingCommitPublication?: StoredPendingCommitPublication;
}

export interface PersistenceValidation {
  readonly invalid: (detail: string) => Error;
}

export function parseStoredWorkspace<TFile extends { readonly path: string }>(
  value: unknown,
  expectedVersion: number,
  rootLabel: string,
  validation: PersistenceValidation,
  parseFile: (value: unknown, field: string) => TFile,
): StoredWorkspaceSnapshotShape<TFile> {
  const root = requireRecord(value, rootLabel, validation);
  if (root.version !== expectedVersion) {
    throw validation.invalid(`unsupported version ${String(root.version)}`);
  }

  const selectedBranch = requireString(root.selectedBranch, 'selectedBranch', validation);
  const rawBranches = requireRecord(root.branches, 'branches', validation);
  const branches = Object.create(null) as Record<string, StoredBranchWorkspaceSnapshot<TFile>>;
  const pendingCommitPublication =
    root.pendingCommitPublication === undefined
      ? undefined
      : parsePendingCommitPublication(root.pendingCommitPublication, validation);

  for (const [name, value] of Object.entries(rawBranches)) {
    const branchField = `branches.${name}`;
    const branch = requireRecord(value, branchField, validation);
    const overlay = requireRecord(branch.overlay, `${branchField}.overlay`, validation);
    const filesField = `${branchField}.overlay.files`;
    branches[name] = {
      baseRevision: requireString(branch.baseRevision, `${branchField}.baseRevision`, validation),
      overlay: {
        files: requireArray(overlay.files, filesField, validation).map((file, index) =>
          parseFile(file, `${filesField}[${index}]`),
        ),
        directories: requireStringArray(
          overlay.directories,
          `${branchField}.overlay.directories`,
          validation,
        ),
        deletedPaths: requireStringArray(
          overlay.deletedPaths,
          `${branchField}.overlay.deletedPaths`,
          validation,
        ),
        renames: requireArray(overlay.renames, `${branchField}.overlay.renames`, validation).map(
          (rename, index) => {
            const field = `${branchField}.overlay.renames[${index}]`;
            const item = requireRecord(rename, field, validation);
            return {
              from: requireString(item.from, `${field}.from`, validation),
              to: requireString(item.to, `${field}.to`, validation),
            };
          },
        ),
      },
    };
  }

  if (!Object.hasOwn(branches, selectedBranch)) {
    throw validation.invalid(`selected branch ${selectedBranch} is not present in branches`);
  }
  if (pendingCommitPublication && pendingCommitPublication.branch !== selectedBranch) {
    throw validation.invalid('pending publication branch must be the selected branch');
  }

  return {
    selectedBranch,
    branches,
    ...(pendingCommitPublication ? { pendingCommitPublication } : {}),
  };
}

export function toWorkspaceSnapshotSync<TFile extends { readonly path: string }>(
  stored: StoredWorkspaceSnapshotShape<TFile>,
  decodeFiles: (
    files: readonly TFile[],
  ) => WorkspaceSnapshot['branches'][string]['overlay']['files'],
): WorkspaceSnapshot {
  const branches = Object.create(null) as Record<string, WorkspaceSnapshot['branches'][string]>;
  for (const [name, branch] of Object.entries(stored.branches)) {
    branches[name] = {
      baseRevision: branch.baseRevision,
      overlay: {
        files: decodeFiles(branch.overlay.files),
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

export function toWorkspaceSnapshot<TFile extends { readonly path: string }>(
  stored: StoredWorkspaceSnapshotShape<TFile>,
  decodeFiles: (
    files: readonly TFile[],
  ) => Promise<WorkspaceSnapshot['branches'][string]['overlay']['files']>,
): Promise<WorkspaceSnapshot> {
  return decodeWorkspace(stored, decodeFiles);
}

async function decodeWorkspace<TFile extends { readonly path: string }>(
  stored: StoredWorkspaceSnapshotShape<TFile>,
  decodeFiles: (
    files: readonly TFile[],
  ) => Promise<WorkspaceSnapshot['branches'][string]['overlay']['files']>,
): Promise<WorkspaceSnapshot> {
  const branches = Object.create(null) as Record<string, WorkspaceSnapshot['branches'][string]>;
  for (const [name, branch] of Object.entries(stored.branches)) {
    branches[name] = {
      baseRevision: branch.baseRevision,
      overlay: {
        files: await decodeFiles(branch.overlay.files),
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

export function requireRecord(
  value: unknown,
  field: string,
  validation: PersistenceValidation,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validation.invalid(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireString(
  value: unknown,
  field: string,
  validation: PersistenceValidation,
): string {
  if (typeof value !== 'string' || !value) {
    throw validation.invalid(`${field} must be a non-empty string`);
  }
  return value;
}

export function requireNonNegativeInteger(
  value: unknown,
  field: string,
  validation: PersistenceValidation,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw validation.invalid(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function parsePendingCommitPublication(
  value: unknown,
  validation: PersistenceValidation,
): StoredPendingCommitPublication {
  const pending = requireRecord(value, 'pendingCommitPublication', validation);
  const branch = requireString(pending.branch, 'pendingCommitPublication.branch', validation);
  const expectedRemoteRevision = requireString(
    pending.expectedRemoteRevision,
    'pendingCommitPublication.expectedRemoteRevision',
    validation,
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
        validation,
      ),
    };
  }
  throw validation.invalid(
    `pendingCommitPublication.phase is unsupported: ${String(pending.phase)}`,
  );
}

function requireArray(
  value: unknown,
  field: string,
  validation: PersistenceValidation,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw validation.invalid(`${field} must be an array`);
  }
  return value;
}

function requireStringArray(
  value: unknown,
  field: string,
  validation: PersistenceValidation,
): readonly string[] {
  return requireArray(value, field, validation).map((item, index) =>
    requireString(item, `${field}[${index}]`, validation),
  );
}
