export type { Disposable, EventListenerErrorHandler } from './events/events.js';
export { EventSource } from './events/events.js';
export { MemoryWorkspaceStorage } from './persistence/memory-workspace-storage.js';
export type {
  BranchWorkspaceSnapshot,
  WorkspaceSnapshot,
  WorkspaceStorage,
} from './persistence/workspace-storage.js';
export type { FileStat, RepositoryReaderOptions } from './repository/repository-reader.js';
export { RepositoryReader } from './repository/repository-reader.js';
export type { RevisionCacheOptions } from './repository/revision-cache.js';
export { DEFAULT_REVISION_CACHE_MAX_BYTES, RevisionCache } from './repository/revision-cache.js';
export type { WorkingTreeChange } from './working-tree/change.js';
export type { WorkingTreeSnapshot } from './working-tree/working-tree.js';
export { WorkingTree } from './working-tree/working-tree.js';
export type { RemoteHeadRefreshResult } from './workspace/branch-service.js';
export type { WorkspaceChangedEvent } from './workspace/workspace.js';
export { RemotishWorkspace } from './workspace/workspace.js';
