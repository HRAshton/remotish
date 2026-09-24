import {
  decodeRpcRequest,
  decodeRpcSession,
  encodeRpcFailure,
  encodeRpcSuccess,
  type RpcRequest,
} from '@remotish/adapter-rpc';
import { RemotishError } from '@remotish/adapter-sdk';
import type { BrowserRpcEndpointBroker } from '../broker.js';
import { normalizeBrowserRpcTarget } from '../target.js';
import { type BrowserRpcFrame, decryptFrame, encryptFrame, randomTransportId } from './wire.js';

export const BROWSER_RPC_CHANNEL = 'remotish-browser-rpc-v1';
const MAX_ENDPOINTS = 32;
const MAX_PENDING = 32;
const REQUEST_TIMEOUT_MS = 60_000;
const STALE_MS = 15_000;
const MAX_SESSION_IDS = 4096;

interface Channel {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(value: unknown): void;
  close(): void;
}

interface EndpointState {
  readonly origin: string;
  readonly target: string;
  readonly session: string;
  readonly registration: { dispose(): void };
  counter: number;
  lastSeen: number;
}

interface PendingRequest {
  readonly endpointId: string;
  readonly resolve: (response: unknown) => void;
  readonly reject: (error: RemotishError) => void;
}

/** Authenticated browser-worker side of the cross-tab bridge. */
export class BrowserRpcHostTransport {
  readonly hostId = randomTransportId();
  private readonly endpoints = new Map<string, EndpointState>();
  private readonly seenEndpointIds = new Set<string>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly channel: Channel;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private disposed: boolean = false;

  constructor(
    private readonly broker: BrowserRpcEndpointBroker,
    private readonly key: CryptoKey,
    channel: Channel = new BroadcastChannel(BROWSER_RPC_CHANNEL),
    private readonly now: () => number = Date.now,
  ) {
    this.channel = channel;
    channel.onmessage = (event) => {
      // Unauthenticated or malformed page traffic cannot affect endpoint or request state.
      this.receive(event.data).catch(() => {});
    };
    this.sweepTimer = setInterval(() => {
      this.sweep();
      // A newly opened tab can miss the first hello; reannounce this host session.
      this.send({ version: 1, kind: 'hello', hostId: this.hostId }).catch(() => {});
    }, 5_000);
  }

  async start(): Promise<void> {
    await this.send({ version: 1, kind: 'hello', hostId: this.hostId });
  }

  /** Dispose expired endpoint sessions; the next RPC call may wait for a fresh compatible one. */
  sweep(): void {
    if (this.disposed) {
      return;
    }
    for (const [endpointId, endpoint] of this.endpoints) {
      const hasPending = [...this.pending.values()].some(
        (request) => request.endpointId === endpointId,
      );
      if (!hasPending && this.now() - endpoint.lastSeen > STALE_MS) {
        this.disconnect(endpointId);
      }
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearInterval(this.sweepTimer);
    this.channel.onmessage = null;
    this.channel.close();
    for (const endpointId of [...this.endpoints.keys()]) {
      this.disconnect(endpointId);
    }
    this.seenEndpointIds.clear();
  }

  private async receive(raw: unknown): Promise<void> {
    if (this.disposed) {
      return;
    }
    const frame = await decryptFrame(this.key, raw);
    if (this.disposed) {
      return;
    }
    switch (frame.kind) {
      case 'register':
        if (frame.hostId === this.hostId) {
          this.register(frame);
        }
        break;
      case 'heartbeat': {
        const endpoint = this.endpoints.get(frame.endpointId);
        if (frame.hostId === this.hostId && endpoint && frame.counter > endpoint.counter) {
          endpoint.counter = frame.counter;
          endpoint.lastSeen = this.now();
        }
        break;
      }
      case 'disconnect': {
        if (frame.hostId !== this.hostId) {
          break;
        }
        const endpoint = this.endpoints.get(frame.endpointId);
        if (endpoint && frame.counter > endpoint.counter) {
          this.disconnect(frame.endpointId);
        } else if (!endpoint && this.seenEndpointIds.size < MAX_SESSION_IDS) {
          // A disconnect may overtake registration in GM storage. Never resurrect that tab.
          this.seenEndpointIds.add(frame.endpointId);
        }
        break;
      }
      case 'response': {
        if (frame.hostId !== this.hostId || !this.endpoints.has(frame.endpointId)) {
          break;
        }
        const pending = this.pending.get(frame.requestId);
        if (pending?.endpointId === frame.endpointId) {
          const endpoint = this.endpoints.get(frame.endpointId);
          if (endpoint) {
            endpoint.lastSeen = this.now();
          }
          pending.resolve(frame.response);
        }
        break;
      }
      case 'hello':
      case 'request':
      case 'cancel':
        break;
    }
  }

  private register(frame: Extract<BrowserRpcFrame, { kind: 'register' }>): void {
    const target = normalizeBrowserRpcTarget(frame.target);
    const session = JSON.stringify(decodeRpcSession(frame.session));
    const existing = this.endpoints.get(frame.endpointId);
    if (existing) {
      if (frame.counter <= existing.counter) {
        return;
      }
      if (
        existing.target !== target ||
        existing.origin !== frame.origin ||
        existing.session !== session
      ) {
        this.disconnect(frame.endpointId);
        return;
      }
      existing.counter = frame.counter;
      existing.lastSeen = this.now();
      return;
    }
    if (
      this.seenEndpointIds.has(frame.endpointId) ||
      this.seenEndpointIds.size >= MAX_SESSION_IDS ||
      this.endpoints.size >= MAX_ENDPOINTS
    ) {
      return;
    }
    const registration = this.broker.register(
      { origin: frame.origin },
      {
        target,
        session: frame.session,
        transport: {
          request: (request, options) => this.request(frame.endpointId, request, options),
        },
      },
    );
    this.endpoints.set(frame.endpointId, {
      origin: frame.origin,
      target,
      session,
      registration,
      counter: frame.counter,
      lastSeen: this.now(),
    });
    this.seenEndpointIds.add(frame.endpointId);
  }

  private disconnect(endpointId: string): void {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) {
      return;
    }
    this.endpoints.delete(endpointId);
    endpoint.registration.dispose();
    for (const pending of this.pending.values()) {
      if (pending.endpointId === endpointId) {
        pending.reject(new RemotishError('OFFLINE', 'Browser RPC endpoint disconnected.'));
      }
    }
  }

  private request(
    endpointId: string,
    raw: RpcRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<unknown> {
    if (this.disposed || !this.endpoints.has(endpointId)) {
      return Promise.reject(new RemotishError('OFFLINE', 'Browser RPC endpoint disconnected.'));
    }
    if (this.pending.size >= MAX_PENDING) {
      return Promise.reject(new RemotishError('RATE_LIMITED', 'Too many Browser RPC requests.'));
    }
    decodeRpcRequest(raw);
    if (options?.signal?.aborted) {
      return Promise.reject(cancelled());
    }
    const requestId = randomTransportId();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (response: unknown, error?: RemotishError) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        options?.signal?.removeEventListener('abort', onAbort);
        this.pending.delete(requestId);
        if (error) {
          reject(error);
        } else {
          resolve(response);
        }
      };
      const onAbort = () => {
        finish(undefined, cancelled());
        // A cancelled request is best-effort remotely; a late response cannot settle it locally.
        this.send({ version: 1, kind: 'cancel', hostId: this.hostId, endpointId, requestId }).catch(
          () => {},
        );
      };
      const timer = setTimeout(() => {
        finish(undefined, new RemotishError('OFFLINE', 'Browser RPC request timed out.'));
        this.send({ version: 1, kind: 'cancel', hostId: this.hostId, endpointId, requestId }).catch(
          () => {},
        );
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, {
        endpointId,
        resolve: (response) => finish(response),
        reject: (error) => finish(undefined, error),
      });
      options?.signal?.addEventListener('abort', onAbort, { once: true });
      if (options?.signal?.aborted) {
        onAbort();
      } else {
        this.send(
          {
            version: 1,
            kind: 'request',
            hostId: this.hostId,
            endpointId,
            requestId,
            request: raw,
          },
          () => this.pending.has(requestId),
        )
          .then((outcome) => {
            if (outcome === 'unsendable') {
              // Encryption rejected this frame before postMessage: publication did not start.
              finish(
                raw.operation === 'commit'
                  ? encodeRpcSuccess('commit', {
                      status: 'rejected',
                      reason: 'UNSUPPORTED',
                      message: 'Browser RPC commit exceeds the transport size limit.',
                    })
                  : encodeRpcFailure('INVALID_REQUEST'),
              );
            }
          })
          .catch(() => {
            // A postMessage failure may be ambiguous, especially for commit publication.
            finish(undefined, new RemotishError('OFFLINE', 'Browser RPC transport failed.'));
          });
      }
    });
  }

  private async send(
    frame: BrowserRpcFrame,
    stillNeeded: () => boolean = () => true,
  ): Promise<'sent' | 'skipped' | 'unsendable'> {
    if (this.disposed) {
      throw new RemotishError('OFFLINE', 'Browser RPC bridge disconnected.');
    }
    let packet: string;
    try {
      packet = await encryptFrame(this.key, frame);
    } catch (error) {
      if (error instanceof RemotishError && error.code === 'INVALID_REQUEST') {
        return 'unsendable';
      }
      throw error;
    }
    if (!this.disposed && stillNeeded()) {
      this.channel.postMessage(packet);
      return 'sent';
    }
    return 'skipped';
  }
}

function cancelled(): RemotishError {
  return new RemotishError('CANCELLED', 'Browser RPC request cancelled.');
}
