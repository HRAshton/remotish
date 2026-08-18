import type { WorkspaceSnapshot } from '@remotish/core';

/** Content-addressed file reference used by storageUri-backed workspace manifests. */
export interface StoredBlobReference {
  readonly sha256: string;
  readonly size: number;
}

interface StoredOverlayFile {
  readonly path: string;
  readonly blob: StoredBlobReference;
}

interface StoredRenameSnapshot {
  readonly from: string;
  readonly to: string;
}

interface StoredBranchWorkspaceSnapshot {
  readonly baseRevision: string;
  readonly overlay: {
    readonly files: readonly StoredOverlayFile[];
    readonly directories: readonly string[];
    readonly deletedPaths: readonly string[];
    readonly renames: readonly StoredRenameSnapshot[];
  };
}

/** Manifest persisted separately from raw content-addressed overlay blobs. */
export interface StoredStorageUriWorkspaceManifest {
  readonly version: 2;
  readonly selectedBranch: string;
  readonly branches: Readonly<Record<string, StoredBranchWorkspaceSnapshot>>;
}

/** Builds a manifest while handing raw overlay bytes to the storage implementation. */
export async function encodeStorageUriWorkspaceManifest(
  snapshot: WorkspaceSnapshot,
  storeBlob: (content: Uint8Array) => Promise<StoredBlobReference>,
): Promise<StoredStorageUriWorkspaceManifest> {
  const branches = Object.create(null) as Record<string, StoredBranchWorkspaceSnapshot>;
  for (const [name, branch] of Object.entries(snapshot.branches)) {
    branches[name] = {
      baseRevision: branch.baseRevision,
      overlay: {
        files: await Promise.all(
          branch.overlay.files.map(async (file) => ({
            path: file.path,
            blob: await storeBlob(file.content),
          })),
        ),
        directories: [...branch.overlay.directories],
        deletedPaths: [...branch.overlay.deletedPaths],
        renames: branch.overlay.renames.map((rename) => ({ ...rename })),
      },
    };
  }
  return { version: 2, selectedBranch: snapshot.selectedBranch, branches };
}

/** Restores and validates a content-addressed storage manifest. */
export async function decodeStorageUriWorkspaceManifest(
  value: unknown,
  readBlob: (blob: StoredBlobReference) => Promise<Uint8Array>,
): Promise<WorkspaceSnapshot> {
  const stored = requireStorageUriWorkspaceManifest(value);
  const branches = Object.create(null) as Record<string, WorkspaceSnapshot['branches'][string]>;

  for (const [name, branch] of Object.entries(stored.branches)) {
    branches[name] = {
      baseRevision: branch.baseRevision,
      overlay: {
        files: await Promise.all(
          branch.overlay.files.map(async (file) => ({
            path: file.path,
            content: await readBlob(file.blob),
          })),
        ),
        directories: [...branch.overlay.directories],
        deletedPaths: [...branch.overlay.deletedPaths],
        renames: branch.overlay.renames.map((rename) => ({ ...rename })),
      },
    };
  }

  return { version: 1, selectedBranch: stored.selectedBranch, branches };
}

/** Returns the blob hashes referenced by a validated persisted manifest. */
export function referencedStorageBlobIds(value: unknown): ReadonlySet<string> {
  const stored = requireStorageUriWorkspaceManifest(value);
  const result = new Set<string>();
  for (const branch of Object.values(stored.branches)) {
    for (const file of branch.overlay.files) {
      result.add(file.blob.sha256);
    }
  }
  return result;
}

function requireStorageUriWorkspaceManifest(value: unknown): StoredStorageUriWorkspaceManifest {
  const snapshot = requireRecord(value, 'workspace manifest');
  if (snapshot.version !== 2) {
    throw invalidManifest(`unsupported version ${String(snapshot.version)}`);
  }

  const selectedBranch = requireString(snapshot.selectedBranch, 'selectedBranch');
  const storedBranches = requireRecord(snapshot.branches, 'branches');
  const branches = Object.create(null) as Record<string, StoredBranchWorkspaceSnapshot>;

  for (const [name, value] of Object.entries(storedBranches)) {
    const branch = requireRecord(value, `branches.${name}`);
    const overlay = requireRecord(branch.overlay, `branches.${name}.overlay`);
    branches[name] = {
      baseRevision: requireString(branch.baseRevision, `branches.${name}.baseRevision`),
      overlay: {
        files: requireArray(overlay.files, `branches.${name}.overlay.files`).map((file, index) => {
          const item = requireRecord(file, `branches.${name}.overlay.files[${index}]`);
          const blob = requireRecord(item.blob, `branches.${name}.overlay.files[${index}].blob`);
          const sha256 = requireString(
            blob.sha256,
            `branches.${name}.overlay.files[${index}].blob.sha256`,
          );
          if (!/^[a-f0-9]{64}$/u.test(sha256)) {
            throw invalidManifest(
              `branches.${name}.overlay.files[${index}].blob.sha256 is invalid`,
            );
          }
          return {
            path: requireString(item.path, `branches.${name}.overlay.files[${index}].path`),
            blob: {
              sha256,
              size: requireNonNegativeInteger(
                blob.size,
                `branches.${name}.overlay.files[${index}].blob.size`,
              ),
            },
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
    throw invalidManifest(`selected branch ${selectedBranch} is not present in branches`);
  }
  return { version: 2, selectedBranch, branches };
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidManifest(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw invalidManifest(`${field} must be an array`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) {
    throw invalidManifest(`${field} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  return requireArray(value, field).map((item, index) => requireString(item, `${field}[${index}]`));
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidManifest(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function invalidManifest(detail: string): Error {
  return new Error(`Invalid persisted Remotish workspace manifest: ${detail}.`);
}
