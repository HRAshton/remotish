import type * as vscode from 'vscode';
import type {
  WorkspaceRegistry,
  WorkspaceRegistryEvent,
} from '../workspaces/workspace-registry.js';
import { BranchStatus } from './status.js';

/** Keeps branch status-bar UI synchronized with workspace registrations and branch changes. */
export class BranchUiManager implements vscode.Disposable {
  private readonly entries = new Map<string, BranchStatus>();
  private readonly registrySubscription: vscode.Disposable;

  constructor(private readonly registry: WorkspaceRegistry) {
    for (const registration of registry.list()) {
      this.add(registration.id);
    }
    this.registrySubscription = registry.onDidChange((event) => this.handleRegistryEvent(event));
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
    const workspace = this.registry.require(workspaceId).workspace;
    this.entries.set(workspaceId, new BranchStatus(workspaceId, workspace));
  }

  private remove(workspaceId: string): void {
    this.entries.get(workspaceId)?.dispose();
    this.entries.delete(workspaceId);
  }
}
