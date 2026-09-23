import { decodeRpcSession, type RpcTransport } from '@remotish/adapter-rpc';
import { RemotishError } from '@remotish/adapter-sdk';
import { normalizeBrowserRpcTarget } from './target.js';

const DEFAULT_WAIT_MS = 30_000;

/** Transport-owned metadata. A remote RPC payload must never supply this value. */
export interface BrowserRpcTransportMetadata {
  readonly origin: string;
}

/** Ephemeral endpoint claim and protocol session, separate from trusted transport metadata. */
export interface BrowserRpcEndpoint {
  readonly target: string;
  readonly session: unknown;
  readonly transport: RpcTransport;
}

/** A selected live registration; disposal prevents future selection, not in-flight calls. */
export interface RegisteredBrowserRpcEndpoint {
  readonly session: unknown;
  readonly transport: RpcTransport;
}

interface Registration extends RegisteredBrowserRpcEndpoint {
  readonly target: string;
  readonly origin: string;
}

interface Waiter {
  readonly target: string;
  readonly resolve: (endpoint: RegisteredBrowserRpcEndpoint) => void;
  readonly reject: (error: RemotishError) => void;
}

/** Session-local endpoint registry with origin-first matching and bounded, cancellable waits. */
export class BrowserRpcEndpointBroker {
  private readonly registrations = new Set<Registration>();
  private readonly waiters = new Set<Waiter>();
  private scheduled: boolean = false;
  private disposed: boolean = false;

  register(
    metadata: BrowserRpcTransportMetadata,
    endpoint: BrowserRpcEndpoint,
  ): { dispose(): void } {
    this.requireActive();
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      Object.keys(metadata).length !== 1 ||
      !Object.hasOwn(metadata, 'origin')
    ) {
      throw new RemotishError('INVALID_REQUEST', 'Invalid Browser RPC transport metadata.');
    }
    if (
      !endpoint ||
      typeof endpoint !== 'object' ||
      Object.keys(endpoint).length !== 3 ||
      !Object.hasOwn(endpoint, 'target') ||
      !Object.hasOwn(endpoint, 'session') ||
      !Object.hasOwn(endpoint, 'transport')
    ) {
      throw new RemotishError('INVALID_REQUEST', 'Invalid Browser RPC endpoint.');
    }
    const origin = normalizeOrigin(metadata.origin);
    const target = normalizeBrowserRpcTarget(endpoint.target);
    if (new URL(target).origin !== origin) {
      throw new RemotishError('INVALID_REQUEST', 'Browser RPC endpoint origin mismatch.');
    }
    if (!endpoint.transport || typeof endpoint.transport.request !== 'function') {
      throw new RemotishError('INVALID_REQUEST', 'Invalid Browser RPC endpoint transport.');
    }
    const session = decodeRpcSession(endpoint.session);
    const registration: Registration = { origin, target, session, transport: endpoint.transport };
    this.registrations.add(registration);
    this.scheduleWaiters();
    return {
      dispose: () => {
        this.registrations.delete(registration);
      },
    };
  }

  find(targetValue: string): RegisteredBrowserRpcEndpoint | undefined {
    this.requireActive();
    const target = normalizeBrowserRpcTarget(targetValue);
    const origin = new URL(target).origin;
    let match: Registration | undefined;
    for (const endpoint of this.registrations) {
      // Origin is trusted transport metadata; a matching endpoint claim alone is insufficient.
      if (endpoint.origin !== origin || endpoint.target !== target) {
        continue;
      }
      if (match) {
        throw new RemotishError('INVALID_REQUEST', 'Ambiguous Browser RPC endpoints.');
      }
      match = endpoint;
    }
    return match ? { session: match.session, transport: match.transport } : undefined;
  }

  waitFor(
    targetValue: string,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): Promise<RegisteredBrowserRpcEndpoint> {
    this.requireActive();
    const target = normalizeBrowserRpcTarget(targetValue);
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > DEFAULT_WAIT_MS) {
      throw new RemotishError('INVALID_REQUEST', 'Invalid Browser RPC wait timeout.');
    }
    if (options.signal?.aborted) {
      return Promise.reject(cancelled());
    }
    try {
      const available = this.find(target);
      if (available) {
        return Promise.resolve(available);
      }
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const onAbort = () => finish(undefined, cancelled());
      const finish = (endpoint?: RegisteredBrowserRpcEndpoint, error?: RemotishError) => {
        if (settled) {
          return;
        }
        settled = true;
        this.waiters.delete(waiter);
        options.signal?.removeEventListener('abort', onAbort);
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        if (error) {
          reject(error);
        } else if (endpoint) {
          resolve(endpoint);
        }
      };
      const waiter: Waiter = {
        target,
        resolve: (endpoint) => finish(endpoint),
        reject: (error) => finish(undefined, error),
      };
      this.waiters.add(waiter);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
      } else {
        timer = setTimeout(
          () =>
            finish(undefined, new RemotishError('OFFLINE', 'Browser RPC endpoint unavailable.')),
          timeoutMs,
        );
      }
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.registrations.clear();
    for (const waiter of [...this.waiters]) {
      waiter.reject(new RemotishError('OFFLINE', 'Browser RPC broker disposed.'));
    }
  }

  private scheduleWaiters(): void {
    if (this.scheduled) {
      return;
    }
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      for (const waiter of [...this.waiters]) {
        try {
          const endpoint = this.find(waiter.target);
          if (endpoint) {
            waiter.resolve(endpoint);
          }
        } catch (error) {
          waiter.reject(
            error instanceof RemotishError
              ? error
              : new RemotishError('UNKNOWN', 'Browser RPC endpoint selection failed.'),
          );
        }
      }
    });
  }

  private requireActive(): void {
    if (this.disposed) {
      throw new RemotishError('OFFLINE', 'Browser RPC broker disposed.');
    }
  }
}

function normalizeOrigin(value: unknown): string {
  const normalized = normalizeBrowserRpcTarget(value);
  const url = new URL(normalized);
  if (url.pathname !== '/' || (value !== url.origin && value !== `${url.origin}/`)) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Browser RPC transport origin.');
  }
  return url.origin;
}

function cancelled(): RemotishError {
  return new RemotishError('CANCELLED', 'Browser RPC endpoint wait cancelled.');
}
