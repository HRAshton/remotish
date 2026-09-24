import {
  decodeRpcRequest,
  decodeRpcSession,
  encodeRpcFailure,
  encodeRpcSuccess,
  type RpcRequest,
} from '@remotish/adapter-rpc';
import { RemotishError } from '@remotish/adapter-sdk';
import { normalizeBrowserRpcTarget } from '../target.js';
import { GmMailbox, type GmStorage } from './gm-mailbox.js';
import { BROWSER_RPC_CHANNEL } from './host.js';
import {
  type BrowserRpcFrame,
  decryptFrame,
  encryptFrame,
  MAX_PACKET_CHARS,
  randomTransportId,
} from './wire.js';

const MAX_ACTIVE_REQUESTS = 32;
const ENDPOINT_REQUEST_MS = 60_000;
const MAX_HOSTS = 32;
const MAX_REQUEST_IDS = 65_536;
const HOST_STALE_MS = 30_000;

interface Channel {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(value: unknown): void;
  close(): void;
}

export interface UserscriptEndpoint {
  readonly target: string;
  readonly session: unknown;
  handle(request: RpcRequest, signal: AbortSignal): Promise<unknown>;
}

/** Relay only authenticated transport frames between a Code-OSS tab and GM storage. */
export class BrowserRpcUserscriptHostRelay {
  private readonly mailbox: GmMailbox;
  private readonly channel: Channel;
  private disposed: boolean = false;

  constructor(
    storage: GmStorage,
    private readonly key: CryptoKey,
    channel: Channel = new BroadcastChannel(BROWSER_RPC_CHANNEL),
  ) {
    this.channel = channel;
    this.mailbox = new GmMailbox(storage, (packet) => {
      this.fromMailbox(packet).catch(() => {});
    });
    channel.onmessage = (event) => {
      this.fromChannel(event.data).catch(() => {});
    };
  }

  async poll(): Promise<void> {
    await this.mailbox.poll();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.mailbox.dispose();
    this.channel.onmessage = null;
    this.channel.close();
  }

  private async fromChannel(raw: unknown): Promise<void> {
    if (this.disposed || typeof raw !== 'string' || raw.length > MAX_PACKET_CHARS) {
      return;
    }
    const frame = await decryptFrame(this.key, raw);
    if (frame.kind === 'hello' || frame.kind === 'request' || frame.kind === 'cancel') {
      await this.mailbox.send(raw);
    }
  }

  private async fromMailbox(packet: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    const frame = await decryptFrame(this.key, packet);
    if (
      frame.kind === 'register' ||
      frame.kind === 'heartbeat' ||
      frame.kind === 'disconnect' ||
      frame.kind === 'response'
    ) {
      this.channel.postMessage(packet);
    }
  }
}

/** Endpoint-side runtime: origin comes from the userscript execution context, not its handler. */
export class BrowserRpcUserscriptEndpoint {
  readonly endpointId = randomTransportId();
  private readonly mailbox: GmMailbox;
  private readonly active = new Map<string, AbortController>();
  private readonly hosts = new Map<string, { counter: number; lastSeen: number }>();
  private readonly seenRequestIds = new Set<string>();
  private readonly heartbeatTimer: ReturnType<typeof setInterval>;
  private readonly target: string;
  private readonly session: ReturnType<typeof decodeRpcSession>;
  private readonly origin = globalThis.location.origin;
  private disposed: boolean = false;

  constructor(
    storage: GmStorage,
    private readonly key: CryptoKey,
    private readonly endpoint: UserscriptEndpoint,
  ) {
    this.target = normalizeBrowserRpcTarget(endpoint.target);
    if (new URL(this.target).origin !== this.origin) {
      throw new RemotishError('INVALID_REQUEST', 'Browser RPC endpoint origin mismatch.');
    }
    this.session = decodeRpcSession(endpoint.session);
    this.mailbox = new GmMailbox(storage, (packet) => {
      this.receive(packet).catch(() => {});
    });
    this.heartbeatTimer = setInterval(() => {
      this.sweepHosts();
      for (const hostId of this.hosts.keys()) {
        this.send({
          version: 1,
          kind: 'heartbeat',
          hostId,
          endpointId: this.endpointId,
          counter: this.nextCounter(hostId),
        }).catch(() => {});
      }
    }, 5_000);
  }

  async start(): Promise<void> {
    await this.mailbox.poll();
  }

  async poll(): Promise<void> {
    await this.mailbox.poll();
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    for (const controller of this.active.values()) {
      controller.abort();
    }
    this.active.clear();
    try {
      await Promise.all(
        [...this.hosts.keys()].map((hostId) =>
          this.send({
            version: 1,
            kind: 'disconnect',
            hostId,
            endpointId: this.endpointId,
            counter: this.nextCounter(hostId),
          }),
        ),
      );
    } finally {
      this.disposed = true;
      this.mailbox.dispose();
      this.hosts.clear();
      this.seenRequestIds.clear();
    }
  }

  private nextCounter(hostId: string): number {
    const state = this.hosts.get(hostId);
    const next = (state?.counter ?? 0) + 1;
    if (!Number.isSafeInteger(next)) {
      throw new RemotishError('RATE_LIMITED', 'Browser RPC session counter exhausted.');
    }
    this.hosts.set(hostId, { counter: next, lastSeen: state?.lastSeen ?? Date.now() });
    return next;
  }

  private sweepHosts(): void {
    for (const [hostId, state] of this.hosts) {
      if (Date.now() - state.lastSeen > HOST_STALE_MS) {
        this.hosts.delete(hostId);
      }
    }
  }

  private async announce(hostId: string): Promise<void> {
    this.sweepHosts();
    if (!this.hosts.has(hostId) && this.hosts.size >= MAX_HOSTS) {
      return;
    }
    const state = this.hosts.get(hostId);
    if (state) {
      state.lastSeen = Date.now();
    }
    await this.send({
      version: 1,
      kind: 'register',
      hostId,
      endpointId: this.endpointId,
      counter: this.nextCounter(hostId),
      origin: this.origin,
      target: this.target,
      session: this.session,
    });
  }

  private async receive(packet: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    const frame = await decryptFrame(this.key, packet);
    switch (frame.kind) {
      case 'hello':
        await this.announce(frame.hostId);
        break;
      case 'request':
        if (frame.endpointId === this.endpointId && this.hosts.has(frame.hostId)) {
          this.handleRequest(frame).catch(() => {});
        }
        break;
      case 'cancel':
        if (frame.endpointId === this.endpointId && this.hosts.has(frame.hostId)) {
          const requestKey = `${frame.hostId}:${frame.requestId}`;
          // Cancellation may overtake the request in a shared mailbox. Tombstone it so a
          // delayed publication cannot start after its caller has cancelled.
          if (this.seenRequestIds.size < MAX_REQUEST_IDS) {
            this.seenRequestIds.add(requestKey);
          }
          this.active.get(requestKey)?.abort();
        }
        break;
      case 'register':
      case 'heartbeat':
      case 'disconnect':
      case 'response':
        break;
    }
  }

  private async handleRequest(frame: Extract<BrowserRpcFrame, { kind: 'request' }>): Promise<void> {
    const key = `${frame.hostId}:${frame.requestId}`;
    if (this.seenRequestIds.has(key)) {
      return;
    }
    if (this.seenRequestIds.size >= MAX_REQUEST_IDS) {
      await this.respond(frame, encodeRpcFailure('RATE_LIMITED'));
      return;
    }
    this.seenRequestIds.add(key);
    if (this.active.size >= MAX_ACTIVE_REQUESTS) {
      await this.respond(frame, encodeRpcFailure('RATE_LIMITED'));
      return;
    }
    let request: RpcRequest;
    try {
      request = decodeRpcRequest(frame.request);
    } catch {
      await this.respond(frame, encodeRpcFailure('INVALID_REQUEST'));
      return;
    }
    const controller = new AbortController();
    this.active.set(key, controller);
    const timer = setTimeout(() => controller.abort(), ENDPOINT_REQUEST_MS);
    let response: unknown;
    try {
      // A handler may ignore abort. Racing it frees the request slot at cancellation/timeout,
      // while the attached rejection handler prevents a late result from escaping or replying.
      const aborted = new Promise<{ readonly kind: 'aborted' }>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), {
          once: true,
        });
      });
      const handled = this.endpoint.handle(request, controller.signal).then(
        (result) => ({ kind: 'result' as const, result }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      );
      const outcome = await Promise.race([handled, aborted]);
      if (outcome.kind === 'result' && !controller.signal.aborted && !this.disposed) {
        response = encodeRpcSuccess(request.operation, outcome.result);
      } else if (outcome.kind === 'error' && !controller.signal.aborted && !this.disposed) {
        response = encodeRpcFailure(
          outcome.error instanceof RemotishError ? outcome.error.code : 'UNKNOWN',
        );
      }
    } catch (error) {
      if (!controller.signal.aborted && !this.disposed) {
        response = encodeRpcFailure(error instanceof RemotishError ? error.code : 'UNKNOWN');
      }
    } finally {
      clearTimeout(timer);
      this.active.delete(key);
    }
    // Never attempt a second response when delivery was ambiguous (notably for publication).
    if (response !== undefined && !controller.signal.aborted && !this.disposed) {
      await this.respond(frame, response);
    }
  }

  private async respond(
    request: Extract<BrowserRpcFrame, { kind: 'request' }>,
    response: unknown,
  ): Promise<void> {
    const frame: BrowserRpcFrame = {
      version: 1,
      kind: 'response',
      hostId: request.hostId,
      endpointId: this.endpointId,
      requestId: request.requestId,
      response,
    };
    let packet: string;
    try {
      packet = await encryptFrame(this.key, frame);
    } catch (error) {
      if (!(error instanceof RemotishError) || error.code !== 'INVALID_REQUEST') {
        throw error;
      }
      // Serialization failed before storage: a small error response is safe to send once.
      packet = await encryptFrame(this.key, {
        ...frame,
        response: encodeRpcFailure('INVALID_REQUEST'),
      });
    }
    await this.mailbox.send(packet);
  }

  private async send(frame: BrowserRpcFrame): Promise<void> {
    if (this.disposed) {
      throw new RemotishError('OFFLINE', 'Browser RPC endpoint disconnected.');
    }
    await this.mailbox.send(await encryptFrame(this.key, frame));
  }
}
