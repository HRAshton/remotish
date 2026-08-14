import { type DirectoryEntry, RemotishError } from '@remotish/adapter-sdk';
import type { FileStat } from '@remotish/core';
import type { WorkspaceRegistry } from '../workspaces/workspace-registry.js';
import { parseRepositoryUri, type RepositoryResource, type RepositoryUriLike } from './uri.js';

/** Routes VS Code filesystem operations to registered Remotish workspaces and revision reads. */
export class RepositoryFileSystem {
  constructor(private readonly registry: WorkspaceRegistry) {}

  resolve(uri: RepositoryUriLike): RepositoryResource {
    const resource = parseRepositoryUri(uri);
    this.registry.require(resource.workspaceId);
    return resource;
  }

  async stat(uri: RepositoryUriLike): Promise<FileStat> {
    const resource = this.resolve(uri);
    const workspace = this.registry.require(resource.workspaceId).workspace;
    return resource.view === 'working'
      ? workspace.stat(resource.path)
      : workspace.statRevision(resource.revision, resource.path);
  }

  async readDirectory(uri: RepositoryUriLike): Promise<readonly DirectoryEntry[]> {
    const resource = this.resolve(uri);
    const workspace = this.registry.require(resource.workspaceId).workspace;
    return resource.view === 'working'
      ? workspace.readDirectory(resource.path)
      : workspace.readRevisionDirectory(resource.revision, resource.path);
  }

  async readFile(uri: RepositoryUriLike): Promise<Uint8Array> {
    const resource = this.resolve(uri);
    const workspace = this.registry.require(resource.workspaceId).workspace;
    return resource.view === 'working'
      ? workspace.readFile(resource.path)
      : workspace.readRevisionFile(resource.revision, resource.path);
  }

  async writeFile(
    uri: RepositoryUriLike,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean },
  ): Promise<void> {
    const resource = this.requireWorking(uri);
    await this.registry
      .require(resource.workspaceId)
      .workspace.writeFile(resource.path, content, options);
  }

  async createDirectory(uri: RepositoryUriLike): Promise<void> {
    const resource = this.requireWorking(uri);
    await this.registry.require(resource.workspaceId).workspace.createDirectory(resource.path);
  }

  async delete(uri: RepositoryUriLike, recursive: boolean): Promise<void> {
    const resource = this.requireWorking(uri);
    await this.registry.require(resource.workspaceId).workspace.delete(resource.path, recursive);
  }

  async rename(
    sourceUri: RepositoryUriLike,
    targetUri: RepositoryUriLike,
    overwrite: boolean,
  ): Promise<void> {
    const source = this.requireWorking(sourceUri);
    const target = this.requireWorking(targetUri);
    if (source.workspaceId !== target.workspaceId) {
      throw new RemotishError('INVALID_REQUEST', 'Cannot rename across Remotish workspaces.');
    }
    await this.registry
      .require(source.workspaceId)
      .workspace.rename(source.path, target.path, overwrite);
  }

  isReadonly(uri: RepositoryUriLike): boolean {
    const resource = this.resolve(uri);
    if (resource.view === 'revision') {
      return true;
    }
    return !this.registry.require(resource.workspaceId).workspace.capabilities.commits;
  }

  private requireWorking(uri: RepositoryUriLike): Extract<RepositoryResource, { view: 'working' }> {
    const resource = this.resolve(uri);
    if (resource.view !== 'working') {
      throw new RemotishError('FORBIDDEN', 'Revision resources are read-only.');
    }
    const workspace = this.registry.require(resource.workspaceId).workspace;
    if (!workspace.capabilities.commits) {
      throw new RemotishError('FORBIDDEN', 'This repository is read-only.');
    }
    return resource;
  }
}
