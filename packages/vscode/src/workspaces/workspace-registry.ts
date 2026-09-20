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

export interface WorkspaceWaitOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface WorkspaceRegistryOptions {
  readonly restoreWorkspace?: (workspaceId: string) => Promise<void>;
  readonly defaultRestoreTimeoutMs?: number;
}

interface WorkspaceWaiter {
  resolve(registration: RegisteredWorkspace): void;
  reject(error: unknown): void;
}

/**
 * Tracks active Remotish workspaces and provides a bounded, event-driven cold-start restoration gate.
 *
 * Restoration attempts and waiters are keyed by workspace ID, so a blocked repository never stalls
 * filesystem work for already-ready repositories.
 */
export class WorkspaceRegistry {
  private readonly registrations = new Map<string, RegisteredWorkspace>();
  private readonly workspaceDisposables = new Map<string, Disposable>();
  private readonly events = new EventSource<WorkspaceRegistryEvent>();
  private readonly workspaceEvents = new EventSource<RegisteredWorkspaceChangedEvent>();
  private readonly waiters = new Map<string, Set<WorkspaceWaiter>>();
  private readonly restorationAttempts = new Map<string, Promise<void>>();
  private readonly restoreWorkspace: ((workspaceId: string) => Promise<void>) | undefined;
  private readonly defaultRestoreTimeoutMs: number;

  constructor(options: WorkspaceRegistryOptions = {}) {
    this.restoreWorkspace = options.restoreWorkspace;
    this.defaultRestoreTimeoutMs = options.defaultRestoreTimeoutMs ?? 10_000;
  }

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
    this.resolveWaiters(normalized, registration);
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

  async waitFor(id: string, options: WorkspaceWaitOptions = {}): Promise<RegisteredWorkspace> {
    const normalized = normalizeWorkspaceId(id);
    const existing = this.registrations.get(normalized);
    if (existing) {
      return existing;
    }

    const timeoutMs = options.timeoutMs ?? this.defaultRestoreTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RemotishError('INVALID_REQUEST', 'Workspace restoration timeout must be positive.');
    }
    if (options.signal?.aborted) {
      throw new RemotishError('CANCELLED', `Workspace restoration cancelled for ${normalized}.`);
    }

    const promise = new Promise<RegisteredWorkspace>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        cleanup();
        reject(
          new RemotishError('CANCELLED', `Workspace restoration cancelled for ${normalized}.`),
        );
      };
      const waiter: WorkspaceWaiter = {
        resolve: (registration) => {
          cleanup();
          resolve(registration);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      const cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        options.signal?.removeEventListener('abort', onAbort);
        const workspaceWaiters = this.waiters.get(normalized);
        workspaceWaiters?.delete(waiter);
        if (workspaceWaiters?.size === 0) {
          this.waiters.delete(normalized);
        }
      };

      const workspaceWaiters = this.waiters.get(normalized) ?? new Set<WorkspaceWaiter>();
      workspaceWaiters.add(waiter);
      this.waiters.set(normalized, workspaceWaiters);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        cleanup();
        reject(
          new RemotishError(
            'OFFLINE',
            `Timed out restoring Remotish workspace ${normalized} after ${timeoutMs} ms.`,
          ),
        );
      }, timeoutMs);
    });

    this.startRestoration(normalized);
    return promise;
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

  private startRestoration(workspaceId: string): void {
    if (!this.restoreWorkspace || this.restorationAttempts.has(workspaceId)) {
      return;
    }

    const attempt = Promise.resolve()
      .then(() => this.restoreWorkspace?.(workspaceId))
      .then(() => undefined)
      .catch((error: unknown) => {
        this.rejectWaiters(workspaceId, error);
      })
      .finally(() => {
        this.restorationAttempts.delete(workspaceId);
      });
    this.restorationAttempts.set(workspaceId, attempt);
  }

  private resolveWaiters(workspaceId: string, registration: RegisteredWorkspace): void {
    for (const waiter of [...(this.waiters.get(workspaceId) ?? [])]) {
      waiter.resolve(registration);
    }
  }

  private rejectWaiters(workspaceId: string, error: unknown): void {
    for (const waiter of [...(this.waiters.get(workspaceId) ?? [])]) {
      waiter.reject(error);
    }
  }
}

function normalizeWorkspaceId(id: string): string {
  const normalized = id.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(normalized)) {
    throw new RemotishError('INVALID_REQUEST', `Invalid workspace id: ${id}`);
  }
  return normalized;
}
