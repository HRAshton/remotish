export type { ScmResourceArgument } from './commands/resource-argument.js';
export {
  parseScmResourceArgument,
  requireScmResourceArgument,
  requireScmWorkspaceId,
} from './commands/resource-argument.js';
export { RepositoryFileSystem } from './filesystem/file-system.js';
export { createRevisionUri, resourcePath } from './filesystem/provider.js';
export type {
  RepositoryResource,
  RepositoryUriLike,
  RepositoryUriParts,
} from './filesystem/uri.js';
export {
  parseRepositoryUri,
  REVISION_SCHEME,
  revisionUriParts,
  WORKING_SCHEME,
  workingUriParts,
} from './filesystem/uri.js';
export { MementoWorkspaceStorage } from './persistence/memento-workspace-storage.js';
export { StorageUriWorkspaceStorage } from './persistence/storage-uri-workspace-storage.js';
export type { StoredWorkspaceSnapshot } from './persistence/workspace-snapshot-codec.js';
export {
  decodeWorkspaceSnapshot,
  encodeWorkspaceSnapshot,
} from './persistence/workspace-snapshot-codec.js';
export type { ScmChangeResourceModel } from './scm/change-resource.js';
export { toScmChangeResource } from './scm/change-resource.js';
export type { ScmManager } from './scm/manager.js';
export type {
  RegisteredWorkspace,
  RegisteredWorkspaceChangedEvent,
  WorkspaceRegistryEvent,
} from './workspaces/workspace-registry.js';
export { WorkspaceRegistry } from './workspaces/workspace-registry.js';
