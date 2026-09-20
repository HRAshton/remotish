import { type DirectoryEntry, RemotishError } from '@remotish/adapter-sdk';
import type { FileStat, RemotishWorkspace } from '@remotish/core';
import type { WorkspaceRegistry } from '../workspaces/workspace-registry.js';
import { parseRepositoryUri, type RepositoryResource, type RepositoryUriLike } from './uri.js';

/** Routes VS Code filesystem operations to registered/restored Remotish workspaces. */
export class RepositoryFileSystem {
  constructor(private readonly registry: WorkspaceRegistry) {}

  async stat(uri: RepositoryUriLike): Promise<FileStat> {
    const { resource, workspace } = await this.resolve(uri);
    return resource.view === 'working'
      ? workspace.stat(resource.path)
      : workspace.statRevision(resource.revision, resource.path);
  }

  async readDirectory(uri: RepositoryUriLike): Promise<readonly DirectoryEntry[]> {
    const { resource, workspace } = await this.resolve(uri);
    return resource.view === 'working'
      ? workspace.readDirectory(resource.path)
      : workspace.readRevisionDirectory(resource.revision, resource.path);
  }

  async readFile(uri: RepositoryUriLike): Promise<Uint8Array> {
    const { resource, workspace } = await this.resolve(uri);
    return resource.view === 'working'
      ? workspace.readFile(resource.path)
      : workspace.readRevisionFile(resource.revision, resource.path);
  }

  async writeFile(
    uri: RepositoryUriLike,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean },
  ): Promise<void> {
    const { resource, workspace } = await this.requireWorking(uri);
    await workspace.writeFile(resource.path, content, options);
  }

  async createDirectory(uri: RepositoryUriLike): Promise<void> {
    const { resource, workspace } = await this.requireWorking(uri);
    await workspace.createDirectory(resource.path);
  }

  async delete(uri: RepositoryUriLike, recursive: boolean): Promise<void> {
    const { resource, workspace } = await this.requireWorking(uri);
    await workspace.delete(resource.path, recursive);
  }

  async rename(
    sourceUri: RepositoryUriLike,
    targetUri: RepositoryUriLike,
    overwrite: boolean,
  ): Promise<void> {
    const source = await this.requireWorking(sourceUri);
    const target = await this.requireWorking(targetUri);
    if (source.resource.workspaceId !== target.resource.workspaceId) {
      throw new RemotishError('INVALID_REQUEST', 'Cannot rename across Remotish workspaces.');
    }
    await source.workspace.rename(source.resource.path, target.resource.path, overwrite);
  }

  async isReadonly(uri: RepositoryUriLike): Promise<boolean> {
    const { resource, workspace } = await this.resolve(uri);
    if (resource.view === 'revision') {
      return true;
    }
    return !workspace.capabilities.commits;
  }

  private async resolve(
    uri: RepositoryUriLike,
  ): Promise<{ readonly resource: RepositoryResource; readonly workspace: RemotishWorkspace }> {
    const resource = parseRepositoryUri(uri);
    const registration = await this.registry.waitFor(resource.workspaceId);
    return { resource, workspace: registration.workspace };
  }

  private async requireWorking(uri: RepositoryUriLike): Promise<{
    readonly resource: Extract<RepositoryResource, { view: 'working' }>;
    readonly workspace: RemotishWorkspace;
  }> {
    const resolved = await this.resolve(uri);
    if (resolved.resource.view !== 'working') {
      throw new RemotishError('FORBIDDEN', 'Revision resources are read-only.');
    }
    if (!resolved.workspace.capabilities.commits) {
      throw new RemotishError('FORBIDDEN', 'This repository is read-only.');
    }
    return { resource: resolved.resource, workspace: resolved.workspace };
  }
}
