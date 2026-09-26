import type { WorkspaceSnapshot } from '@remotish/core';
import {
  parseStoredWorkspace,
  requireNonNegativeInteger,
  requireRecord,
  requireString,
  type StoredBranchWorkspaceSnapshot,
  type StoredPendingCommitPublication,
  toWorkspaceSnapshot,
} from './workspace-persistence-schema.js';

/** Content-addressed file reference used by storageUri-backed workspace manifests. */
export interface StoredBlobReference {
  readonly sha256: string;
  readonly size: number;
}

interface StoredOverlayFile {
  readonly path: string;
  readonly blob: StoredBlobReference;
}

/** Manifest persisted separately from raw content-addressed overlay blobs. */
export interface StoredStorageUriWorkspaceManifest {
  readonly version: 2;
  readonly selectedBranch: string;
  readonly branches: Readonly<Record<string, StoredBranchWorkspaceSnapshot<StoredOverlayFile>>>;
  readonly pendingCommitPublication?: StoredPendingCommitPublication;
}

const validation = {
  invalid: (detail: string) =>
    new Error(`Invalid persisted Remotish workspace manifest: ${detail}.`),
};

/** Builds a manifest while handing raw overlay bytes to the storage implementation. */
export async function encodeStorageUriWorkspaceManifest(
  snapshot: WorkspaceSnapshot,
  storeBlob: (content: Uint8Array) => Promise<StoredBlobReference>,
): Promise<StoredStorageUriWorkspaceManifest> {
  const branches = Object.create(null) as Record<
    string,
    StoredBranchWorkspaceSnapshot<StoredOverlayFile>
  >;
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
  return {
    version: 2,
    selectedBranch: snapshot.selectedBranch,
    branches,
    ...(snapshot.pendingCommitPublication
      ? { pendingCommitPublication: { ...snapshot.pendingCommitPublication } }
      : {}),
  };
}

/** Restores and validates a content-addressed storage manifest. */
export async function decodeStorageUriWorkspaceManifest(
  value: unknown,
  readBlob: (blob: StoredBlobReference) => Promise<Uint8Array>,
): Promise<WorkspaceSnapshot> {
  const stored = requireStorageUriWorkspaceManifest(value);
  return toWorkspaceSnapshot(stored, async (files) =>
    Promise.all(
      files.map(async (file) => ({ path: file.path, content: await readBlob(file.blob) })),
    ),
  );
}

/** Returns the blob hashes referenced by a validated persisted manifest. */
export function referencedStorageBlobIds(value: unknown): ReadonlySet<string> {
  const stored = requireStorageUriWorkspaceManifest(value);
  return new Set(
    Object.values(stored.branches).flatMap((branch) =>
      branch.overlay.files.map((file) => file.blob.sha256),
    ),
  );
}

function requireStorageUriWorkspaceManifest(value: unknown): StoredStorageUriWorkspaceManifest {
  const stored = parseStoredWorkspace(value, 2, 'workspace manifest', validation, (file, field) => {
    const item = requireRecord(file, field, validation);
    const blob = requireRecord(item.blob, `${field}.blob`, validation);
    const sha256 = requireString(blob.sha256, `${field}.blob.sha256`, validation);
    if (!/^[a-f0-9]{64}$/u.test(sha256)) {
      throw validation.invalid(`${field}.blob.sha256 is invalid`);
    }
    return {
      path: requireString(item.path, `${field}.path`, validation),
      blob: {
        sha256,
        size: requireNonNegativeInteger(blob.size, `${field}.blob.size`, validation),
      },
    };
  });
  return { version: 2, ...stored };
}
