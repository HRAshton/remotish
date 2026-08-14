import { RemotishError } from '@remotish/adapter-sdk';
import {
  type Disposable,
  EventSource,
  type RemotishWorkspace,
  type WorkspaceChangedEvent,
} from '@remotish/core';

/** Runtime association between a workspace ID, its Remotish model, and VS Code metadata. */
export interface RegisteredWorkspace {
  readonly id: string;
  readonly workspace: RemotishWorkspace;
}

/** Lifecycle event emitted when a workspace registration is added or removed. */
export type WorkspaceRegistryEvent =
  | { readonly type: 'registered'; readonly registration: RegisteredWorkspace }
  | { readonly type: 'unregistered'; readonly registration: RegisteredWorkspace };

/** Change event emitted after a registered workspace mutates or switches branch/base. */
export interface RegisteredWorkspaceChangedEvent {
  readonly registration: RegisteredWorkspace;
  readonly change: WorkspaceChangedEvent;
}

/** Tracks active Remotish workspaces and exposes lifecycle/change events to VS Code services. */
export class WorkspaceRegistry {
  private readonly registrations = new Map<string, RegisteredWorkspace>();
  private readonly workspaceDisposables = new Map<string, Disposable>();
  private readonly events = new EventSource<WorkspaceRegistryEvent>();
  private readonly workspaceEvents = new EventSource<RegisteredWorkspaceChangedEvent>();

  register(id: string, workspace: RemotishWorkspace): Disposable {
    const normalized = normalizeWorkspaceId(id);
    if (this.registrations.has(normalized)) {
      throw new RemotishError('INVALID_REQUEST', `Workspace ${normalized} is already registered.`);
    }

    const registration = { id: normalized, workspace };
    this.registrations.set(normalized, registration);
    this.workspaceDisposables.set(
      normalized,
      workspace.onDidChange((change) => this.workspaceEvents.emit({ registration, change })),
    );
    this.events.emit({ type: 'registered', registration });

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        this.workspaceDisposables.get(normalized)?.dispose();
        this.workspaceDisposables.delete(normalized);
        const current = this.registrations.get(normalized);
        if (current !== registration) {
          return;
        }
        this.registrations.delete(normalized);
        this.events.emit({ type: 'unregistered', registration });
      },
    };
  }

  get(id: string): RegisteredWorkspace | undefined {
    return this.registrations.get(normalizeWorkspaceId(id));
  }

  require(id: string): RegisteredWorkspace {
    const registration = this.get(id);
    if (!registration) {
      throw new RemotishError('INVALID_REQUEST', `Workspace ${id} is not registered.`);
    }
    return registration;
  }

  list(): readonly RegisteredWorkspace[] {
    return [...this.registrations.values()];
  }

  onDidChange(listener: (event: WorkspaceRegistryEvent) => void): Disposable {
    return this.events.on(listener);
  }

  onDidWorkspaceChange(listener: (event: RegisteredWorkspaceChangedEvent) => void): Disposable {
    return this.workspaceEvents.on(listener);
  }
}

function normalizeWorkspaceId(id: string): string {
  const normalized = id.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized)) {
    throw new RemotishError('INVALID_REQUEST', `Invalid workspace id: ${id}`);
  }
  return normalized;
}
