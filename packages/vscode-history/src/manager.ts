import type { ScmManager, WorkspaceRegistry, WorkspaceRegistryEvent } from '@remotish/vscode/model';
import type * as vscode from 'vscode';
import { RemotishHistoryProvider } from './history-provider.js';

/** Attaches one native SCM history provider per registered Remotish workspace. */
export class HistoryManager implements vscode.Disposable {
  private readonly entries = new Map<string, RemotishHistoryProvider>();
  private readonly registrySubscription: vscode.Disposable;

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly scm: ScmManager,
  ) {
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
    const sourceControl = this.scm.get(workspaceId)?.sourceControl;
    if (!sourceControl) {
      return;
    }
    const workspace = this.registry.require(workspaceId).workspace;
    const provider = new RemotishHistoryProvider(workspaceId, workspace);
    sourceControl.historyProvider = provider;
    this.entries.set(workspaceId, provider);
  }

  private remove(workspaceId: string): void {
    const sourceControl = this.scm.get(workspaceId)?.sourceControl;
    if (sourceControl) {
      delete sourceControl.historyProvider;
    }
    this.entries.get(workspaceId)?.dispose();
    this.entries.delete(workspaceId);
  }
}
