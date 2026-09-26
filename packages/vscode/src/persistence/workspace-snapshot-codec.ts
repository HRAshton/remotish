import type { WorkspaceSnapshot } from '@remotish/core';
import {
  parseStoredWorkspace,
  requireRecord,
  requireString,
  type StoredBranchWorkspaceSnapshot,
  type StoredPendingCommitPublication,
  toWorkspaceSnapshotSync,
} from './workspace-persistence-schema.js';

interface StoredOverlayFile {
  readonly path: string;
  readonly contentBase64: string;
}

/** JSON/base64 representation used by Memento-backed persistence for small workspace snapshots. */
export interface StoredWorkspaceSnapshot {
  readonly version: 1;
  readonly selectedBranch: string;
  readonly branches: Readonly<Record<string, StoredBranchWorkspaceSnapshot<StoredOverlayFile>>>;
  readonly pendingCommitPublication?: StoredPendingCommitPublication;
}

const validation = {
  invalid: (detail: string) => new Error(`Invalid persisted Remotish workspace: ${detail}.`),
};

/** Encodes binary overlay files as base64 for Memento-compatible JSON storage. */
export function encodeWorkspaceSnapshot(snapshot: WorkspaceSnapshot): StoredWorkspaceSnapshot {
  const branches = Object.create(null) as Record<
    string,
    StoredBranchWorkspaceSnapshot<StoredOverlayFile>
  >;
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
  const stored = parseStoredWorkspace(value, 1, 'workspace snapshot', validation, (file, field) => {
    const item = requireRecord(file, field, validation);
    return {
      path: requireString(item.path, `${field}.path`, validation),
      contentBase64: requireString(item.contentBase64, `${field}.contentBase64`, validation),
    };
  });
  return toWorkspaceSnapshotSync(stored, (files) =>
    files.map((file) => ({
      path: file.path,
      content: decodeBase64(file.contentBase64, file.path),
    })),
  );
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
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
