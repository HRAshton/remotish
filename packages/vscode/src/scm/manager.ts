import type * as vscode from 'vscode';
import type {
  WorkspaceRegistry,
  WorkspaceRegistryEvent,
} from '../workspaces/workspace-registry.js';
import { RemotishSourceControl } from './source-control.js';

/** Creates and disposes one native SourceControl integration for each registered workspace. */
export class ScmManager implements vscode.Disposable {
  private readonly entries = new Map<string, RemotishSourceControl>();
  private readonly registrySubscription: vscode.Disposable;

  constructor(private readonly registry: WorkspaceRegistry) {
    for (const registration of registry.list()) {
      this.add(registration.id);
    }
    this.registrySubscription = registry.onDidChange((event) => this.handleRegistryEvent(event));
  }

  get(workspaceId: string): RemotishSourceControl | undefined {
    return this.entries.get(workspaceId);
  }

  dispose(): void {
    this.registrySubscription.dispose();
    for (const entry of this.entries.values()) {
      entry.dispose();
    }
    this.entries.clear();
  }

  private handleRegistryEvent(event: WorkspaceRegistryEvent): void {
    if (event.type === 'registered') {
      this.add(event.registration.id);
    } else {
      this.remove(event.registration.id);
    }
  }

  private add(workspaceId: string): void {
    if (this.entries.has(workspaceId)) {
      return;
    }
    const registration = this.registry.require(workspaceId);
    if (!registration.workspace.capabilities.commits) {
      return;
    }
    this.entries.set(workspaceId, new RemotishSourceControl(workspaceId, registration.workspace));
  }

  private remove(workspaceId: string): void {
    this.entries.get(workspaceId)?.dispose();
    this.entries.delete(workspaceId);
  }
}
