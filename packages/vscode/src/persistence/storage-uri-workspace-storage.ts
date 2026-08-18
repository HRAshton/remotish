import type { RepositoryId } from '@remotish/adapter-sdk';
import type { WorkspaceSnapshot, WorkspaceStorage } from '@remotish/core';
import * as vscode from 'vscode';
import {
  decodeStorageUriWorkspaceManifest,
  encodeStorageUriWorkspaceManifest,
  referencedStorageBlobIds,
  type StoredBlobReference,
} from './storage-uri-workspace-codec.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const POINTER_FILE = 'current.json';
const BACKUP_POINTER_FILE = 'current.backup.json';
const MANIFESTS_DIRECTORY = 'manifests';
const BLOBS_DIRECTORY = 'blobs';

interface StoragePointer {
  readonly version: 1;
  readonly current: string;
  readonly previous?: string;
}

/**
 * Persists workspace snapshots beneath a VS Code extension storage URI.
 *
 * Overlay file bytes are stored as SHA-256-addressed blobs instead of base64 inside one large JSON
 * document. Saves write blobs and a complete manifest first, then replace a tiny current pointer,
 * so an interrupted save leaves the previously committed generation readable.
 */
export class StorageUriWorkspaceStorage implements WorkspaceStorage {
  private readonly lastValidGeneration = new Map<RepositoryId, string>();

  constructor(
    private readonly root: vscode.Uri,
    private readonly namespace = 'default',
    private readonly fileSystem = vscode.workspace.fs,
  ) {}

  async load(repositoryId: RepositoryId): Promise<WorkspaceSnapshot | undefined> {
    const repositoryRoot = this.repositoryRoot(repositoryId);
    const pointer = await this.readPointer(repositoryRoot);
    if (!pointer) {
      return undefined;
    }

    try {
      const snapshot = await this.loadGeneration(repositoryRoot, pointer.current);
      this.lastValidGeneration.set(repositoryId, pointer.current);
      return snapshot;
    } catch (currentError) {
      if (!pointer.previous) {
        throw currentError;
      }

      try {
        const snapshot = await this.loadGeneration(repositoryRoot, pointer.previous);
        this.lastValidGeneration.set(repositoryId, pointer.previous);
        // Recovery must not be blocked if repairing the pointer itself fails.
        await this.writePointer(repositoryRoot, { version: 1, current: pointer.previous }).catch(
          () => undefined,
        );
        return snapshot;
      } catch (previousError) {
        throw new Error('Unable to restore the current or previous Remotish workspace snapshot.', {
          cause: new AggregateError([currentError, previousError]),
        });
      }
    }
  }

  async save(repositoryId: RepositoryId, snapshot: WorkspaceSnapshot): Promise<void> {
    const repositoryRoot = this.repositoryRoot(repositoryId);
    const manifestsRoot = vscode.Uri.joinPath(repositoryRoot, MANIFESTS_DIRECTORY);
    const blobsRoot = vscode.Uri.joinPath(repositoryRoot, BLOBS_DIRECTORY);
    await Promise.all([
      this.fileSystem.createDirectory(manifestsRoot),
      this.fileSystem.createDirectory(blobsRoot),
    ]);

    const manifest = await encodeStorageUriWorkspaceManifest(snapshot, async (content) => {
      const sha256 = await hashBytes(content);
      const blob = { sha256, size: content.byteLength };
      await this.writeBlobIfMissing(blobsRoot, blob, content);
      return blob;
    });
    const manifestContent = encoder.encode(JSON.stringify(manifest));
    const generation = await hashBytes(manifestContent);
    const manifestUri = vscode.Uri.joinPath(manifestsRoot, `${generation}.json`);
    await this.writeFileIfMissing(manifestUri, manifestContent);

    const onDiskPointer = await this.readPointer(repositoryRoot);
    const previous = this.lastValidGeneration.get(repositoryId) ?? onDiskPointer?.current;
    const pointer: StoragePointer =
      previous && previous !== generation
        ? { version: 1, current: generation, previous }
        : { version: 1, current: generation };

    await this.writePointer(repositoryRoot, pointer);
    this.lastValidGeneration.set(repositoryId, generation);
    await this.garbageCollect(repositoryRoot, pointer, manifest).catch(() => undefined);
  }

  async delete(repositoryId: RepositoryId): Promise<void> {
    const repositoryRoot = this.repositoryRoot(repositoryId);
    try {
      await this.fileSystem.delete(repositoryRoot, { recursive: true });
      this.lastValidGeneration.delete(repositoryId);
    } catch (error) {
      if (!isFileNotFound(error)) {
        throw error;
      }
    }
  }

  private async loadGeneration(
    repositoryRoot: vscode.Uri,
    generation: string,
  ): Promise<WorkspaceSnapshot> {
    const manifestsRoot = vscode.Uri.joinPath(repositoryRoot, MANIFESTS_DIRECTORY);
    const blobsRoot = vscode.Uri.joinPath(repositoryRoot, BLOBS_DIRECTORY);
    const manifestContent = await this.fileSystem.readFile(
      vscode.Uri.joinPath(manifestsRoot, `${generation}.json`),
    );
    const actualManifestHash = await hashBytes(manifestContent);
    if (actualManifestHash !== generation) {
      throw new Error(
        `Invalid persisted Remotish workspace manifest ${generation}: checksum mismatch.`,
      );
    }
    const manifest = parseJson(manifestContent, 'workspace manifest');
    return decodeStorageUriWorkspaceManifest(manifest, async (blob) => {
      const content = await this.fileSystem.readFile(blobUri(blobsRoot, blob.sha256));
      if (content.byteLength !== blob.size) {
        throw new Error(
          `Invalid persisted Remotish workspace blob ${blob.sha256}: expected ${blob.size} bytes, ` +
            `found ${content.byteLength}.`,
        );
      }
      const actualHash = await hashBytes(content);
      if (actualHash !== blob.sha256) {
        throw new Error(
          `Invalid persisted Remotish workspace blob ${blob.sha256}: checksum mismatch.`,
        );
      }
      return content;
    });
  }

  private async writeBlobIfMissing(
    blobsRoot: vscode.Uri,
    blob: StoredBlobReference,
    content: Uint8Array,
  ): Promise<void> {
    await this.writeFileIfMissing(blobUri(blobsRoot, blob.sha256), content);
  }

  private async writeFileIfMissing(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    try {
      await this.fileSystem.stat(uri);
      return;
    } catch (error) {
      if (!isFileNotFound(error)) {
        throw error;
      }
    }
    await this.fileSystem.writeFile(uri, content);
  }

  private async readPointer(repositoryRoot: vscode.Uri): Promise<StoragePointer | undefined> {
    let primaryError: unknown;
    try {
      return await this.readPointerFile(repositoryRoot, POINTER_FILE);
    } catch (error) {
      primaryError = error;
    }

    try {
      return await this.readPointerFile(repositoryRoot, BACKUP_POINTER_FILE);
    } catch (backupError) {
      if (isFileNotFound(primaryError) && isFileNotFound(backupError)) {
        return undefined;
      }
      throw new Error('Unable to read the primary or backup Remotish workspace pointer.', {
        cause: new AggregateError([primaryError, backupError]),
      });
    }
  }

  private async readPointerFile(
    repositoryRoot: vscode.Uri,
    fileName: string,
  ): Promise<StoragePointer> {
    const content = await this.fileSystem.readFile(vscode.Uri.joinPath(repositoryRoot, fileName));
    return requirePointer(parseJson(content, 'workspace pointer'));
  }

  private async writePointer(repositoryRoot: vscode.Uri, pointer: StoragePointer): Promise<void> {
    await this.fileSystem.createDirectory(repositoryRoot);
    // Two independently replaced pointer files avoid making one small metadata file a single point
    // of failure. Both only reference generations whose blobs and manifest already exist.
    await this.writePointerFile(repositoryRoot, BACKUP_POINTER_FILE, pointer);
    await this.writePointerFile(repositoryRoot, POINTER_FILE, pointer);
  }

  private async writePointerFile(
    repositoryRoot: vscode.Uri,
    fileName: string,
    pointer: StoragePointer,
  ): Promise<void> {
    const target = vscode.Uri.joinPath(repositoryRoot, fileName);
    const temporary = vscode.Uri.joinPath(repositoryRoot, `${fileName}.${pointer.current}.tmp`);
    await this.fileSystem.writeFile(temporary, encoder.encode(JSON.stringify(pointer)));
    try {
      await this.fileSystem.rename(temporary, target, { overwrite: true });
    } catch (error) {
      try {
        await this.fileSystem.delete(temporary);
      } catch {
        // Best-effort cleanup must not mask the original rename failure.
      }
      throw error;
    }
  }

  private async garbageCollect(
    repositoryRoot: vscode.Uri,
    pointer: StoragePointer,
    currentManifest: unknown,
  ): Promise<void> {
    const manifestsRoot = vscode.Uri.joinPath(repositoryRoot, MANIFESTS_DIRECTORY);
    const blobsRoot = vscode.Uri.joinPath(repositoryRoot, BLOBS_DIRECTORY);
    const retainedManifests = new Set([pointer.current, pointer.previous].filter(Boolean));
    const retainedBlobs = new Set(referencedStorageBlobIds(currentManifest));

    if (pointer.previous) {
      try {
        const previousContent = await this.fileSystem.readFile(
          vscode.Uri.joinPath(manifestsRoot, `${pointer.previous}.json`),
        );
        for (const blob of referencedStorageBlobIds(
          parseJson(previousContent, 'previous workspace manifest'),
        )) {
          retainedBlobs.add(blob);
        }
      } catch {
        // Keep all blobs when the fallback generation cannot be inspected safely.
        return;
      }
    }

    for (const [name, type] of await this.fileSystem.readDirectory(manifestsRoot)) {
      if (type !== vscode.FileType.File || !name.endsWith('.json')) {
        continue;
      }
      const generation = name.slice(0, -'.json'.length);
      if (!retainedManifests.has(generation)) {
        await this.fileSystem.delete(vscode.Uri.joinPath(manifestsRoot, name));
      }
    }

    for (const [name, type] of await this.fileSystem.readDirectory(blobsRoot)) {
      if (type !== vscode.FileType.File || !name.endsWith('.bin')) {
        continue;
      }
      const sha256 = name.slice(0, -'.bin'.length);
      if (!retainedBlobs.has(sha256)) {
        await this.fileSystem.delete(vscode.Uri.joinPath(blobsRoot, name));
      }
    }

    for (const [name, type] of await this.fileSystem.readDirectory(repositoryRoot)) {
      if (type === vscode.FileType.File && name.endsWith('.tmp')) {
        await this.fileSystem.delete(vscode.Uri.joinPath(repositoryRoot, name));
      }
    }
  }

  private repositoryRoot(repositoryId: RepositoryId): vscode.Uri {
    return vscode.Uri.joinPath(
      this.root,
      encodeURIComponent(this.namespace),
      encodeURIComponent(repositoryId),
    );
  }
}

function blobUri(blobsRoot: vscode.Uri, sha256: string): vscode.Uri {
  return vscode.Uri.joinPath(blobsRoot, `${sha256}.bin`);
}

function parseJson(content: Uint8Array, description: string): unknown {
  try {
    return JSON.parse(decoder.decode(content)) as unknown;
  } catch (error) {
    throw new Error(`Invalid persisted Remotish ${description}: invalid JSON.`, { cause: error });
  }
}

function requirePointer(value: unknown): StoragePointer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid persisted Remotish workspace pointer: expected an object.');
  }
  const pointer = value as Record<string, unknown>;
  if (pointer.version !== 1 || !isHash(pointer.current)) {
    throw new Error(
      'Invalid persisted Remotish workspace pointer: unsupported or malformed value.',
    );
  }
  if (pointer.previous !== undefined && !isHash(pointer.previous)) {
    throw new Error('Invalid persisted Remotish workspace pointer: malformed previous generation.');
  }
  return pointer.previous === undefined
    ? { version: 1, current: pointer.current }
    : { version: 1, current: pointer.current, previous: pointer.previous };
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

async function hashBytes(content: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}
