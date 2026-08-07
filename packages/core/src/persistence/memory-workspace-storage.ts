import type { RepositoryId } from '@remotish/adapter-sdk';
import type { WorkspaceSnapshot, WorkspaceStorage } from './workspace-storage.js';

/** In-memory WorkspaceStorage useful for tests and hosts that do not require persistence. */
export class MemoryWorkspaceStorage implements WorkspaceStorage {
  private readonly values = new Map<RepositoryId, WorkspaceSnapshot>();

  async load(repositoryId: RepositoryId): Promise<WorkspaceSnapshot | undefined> {
    const value = this.values.get(repositoryId);
    return value ? structuredClone(value) : undefined;
  }

  async save(repositoryId: RepositoryId, snapshot: WorkspaceSnapshot): Promise<void> {
    this.values.set(repositoryId, structuredClone(snapshot));
  }

  async delete(repositoryId: RepositoryId): Promise<void> {
    this.values.delete(repositoryId);
  }
}
