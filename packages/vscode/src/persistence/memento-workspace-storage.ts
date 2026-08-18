import type { RepositoryId } from '@remotish/adapter-sdk';
import type { WorkspaceSnapshot, WorkspaceStorage } from '@remotish/core';
import type { Memento } from 'vscode';
import { decodeWorkspaceSnapshot, encodeWorkspaceSnapshot } from './workspace-snapshot-codec.js';

/** Persists branch bases, overlays, and selection state in VS Code extension Memento storage. */
export class MementoWorkspaceStorage implements WorkspaceStorage {
  constructor(
    private readonly memento: Memento,
    private readonly namespace = 'default',
  ) {}

  async load(repositoryId: RepositoryId): Promise<WorkspaceSnapshot | undefined> {
    const value = this.memento.get<unknown>(this.key(repositoryId));
    return value === undefined ? undefined : decodeWorkspaceSnapshot(value);
  }

  async save(repositoryId: RepositoryId, snapshot: WorkspaceSnapshot): Promise<void> {
    await this.memento.update(this.key(repositoryId), encodeWorkspaceSnapshot(snapshot));
  }

  async delete(repositoryId: RepositoryId): Promise<void> {
    await this.memento.update(this.key(repositoryId), undefined);
  }

  private key(repositoryId: RepositoryId): string {
    return `remotish.workspace.${encodeURIComponent(this.namespace)}.${encodeURIComponent(repositoryId)}`;
  }
}
