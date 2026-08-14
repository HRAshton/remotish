import { RemotishError } from '@remotish/adapter-sdk';
import * as vscode from 'vscode';
import type { WorkspaceRegistry } from '../workspaces/workspace-registry.js';
import type { RepositoryFileSystem } from './file-system.js';
import { FileTimestampStore } from './timestamps.js';
import { parseRepositoryUri, revisionUriParts, workingUriParts } from './uri.js';

/** Exposes writable working URIs and immutable revision URIs through VS Code FileSystemProvider. */
export class RemotishFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private readonly registrySubscription: vscode.Disposable | undefined;
  private readonly timestamps = new FileTimestampStore();
  readonly onDidChangeFile = this.changes.event;

  constructor(
    registry: WorkspaceRegistry,
    private readonly fileSystem: RepositoryFileSystem,
    view: 'working' | 'revision',
  ) {
    this.registrySubscription =
      view === 'working'
        ? registry.onDidWorkspaceChange(({ registration }) => {
            this.timestamps.invalidateWorkspace(registration.id);
            this.changes.fire([
              {
                type: vscode.FileChangeType.Changed,
                uri: toUri(workingUriParts(registration.id)),
              },
            ]);
          })
        : undefined;
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this.call(uri, async () => {
      const stat = await this.fileSystem.stat(uri);
      const timestamps = this.timestamps.stat(uri);
      return {
        type: stat.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File,
        ctime: timestamps.ctime,
        mtime: timestamps.mtime,
        size: stat.size,
        ...(this.fileSystem.isReadonly(uri) ? { permissions: vscode.FilePermission.Readonly } : {}),
      };
    });
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return this.call(uri, async () =>
      (await this.fileSystem.readDirectory(uri)).map((entry) => [
        entry.name,
        entry.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File,
      ]),
    );
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.call(uri, () => this.fileSystem.readFile(uri));
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    await this.call(uri, async () => {
      await this.fileSystem.writeFile(uri, content, options);
      this.timestamps.touch(uri);
      this.changed(vscode.FileChangeType.Changed, uri);
    });
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    await this.call(uri, async () => {
      await this.fileSystem.createDirectory(uri);
      this.timestamps.touch(uri);
      this.changed(vscode.FileChangeType.Created, uri);
    });
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    await this.call(uri, async () => {
      await this.fileSystem.delete(uri, options.recursive);
      this.timestamps.remove(uri);
      this.changed(vscode.FileChangeType.Deleted, uri);
    });
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { overwrite: boolean },
  ): Promise<void> {
    await this.call(oldUri, async () => {
      await this.fileSystem.rename(oldUri, newUri, options.overwrite);
      this.timestamps.rename(oldUri, newUri);
      this.changes.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri },
      ]);
    });
  }

  dispose(): void {
    this.registrySubscription?.dispose();
    this.changes.dispose();
  }

  private changed(type: vscode.FileChangeType, uri: vscode.Uri): void {
    this.changes.fire([{ type, uri }]);
  }

  private async call<T>(uri: vscode.Uri, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof vscode.FileSystemError) {
        throw error;
      }
      throw toFileSystemError(error, uri);
    }
  }
}

/** Creates the stable editable URI for one path in a registered workspace. */
export function createWorkingUri(workspaceId: string, path = ''): vscode.Uri {
  return toUri(workingUriParts(workspaceId, path));
}

/** Creates an immutable URI pinned to one concrete repository revision. */
export function createRevisionUri(workspaceId: string, revision: string, path = ''): vscode.Uri {
  return toUri(revisionUriParts(workspaceId, revision, path));
}

function toUri(
  parts: ReturnType<typeof workingUriParts> | ReturnType<typeof revisionUriParts>,
): vscode.Uri {
  return vscode.Uri.from(parts);
}

function toFileSystemError(error: unknown, uri: vscode.Uri): vscode.FileSystemError {
  if (error instanceof RemotishError) {
    switch (error.code) {
      case 'NOT_FOUND':
        return vscode.FileSystemError.FileNotFound(uri);
      case 'FORBIDDEN':
      case 'UNAUTHORIZED':
        return vscode.FileSystemError.NoPermissions(error.message);
      case 'INVALID_REQUEST':
        return vscode.FileSystemError.Unavailable(error.message);
      default:
        return vscode.FileSystemError.Unavailable(error.message);
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return vscode.FileSystemError.Unavailable(message);
}

/** Extracts the normalized repository-relative path encoded in a Remotish URI. */
export function resourcePath(uri: vscode.Uri): string {
  return parseRepositoryUri(uri).path;
}
