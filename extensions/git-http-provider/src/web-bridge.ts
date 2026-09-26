import {
  GitHttpNotDispatchedError,
  type GitHttpRequest,
  type GitHttpResponse,
} from '@remotish/adapter-git-http';
import { RemotishError } from '@remotish/adapter-sdk';
import {
  CHANNEL,
  decodeBytes,
  decrypt,
  encodeBytes,
  encrypt,
  importKey,
  randomId,
} from './bridge-wire.js';

const TIMEOUT_MS = 60_000;
const MAX_PENDING = 8;

interface Pending {
  readonly resolve: (value: GitHttpResponse) => void;
  readonly reject: (error: RemotishError) => void;
}

/** Authenticated channel to one Code-OSS-origin userscript instance. */
export class GitHttpWebBridge {
  private readonly channel = new BroadcastChannel(CHANNEL);
  private readonly hostId = randomId();
  private readonly helloId = randomId();
  private readonly pending = new Map<string, Pending>();
  private sessionId?: string;
  private helloResolve: ((sessionId: string) => void) | undefined;
  private disposed: boolean = false;

  private constructor(
    private readonly key: CryptoKey,
    private readonly url: string,
  ) {
    this.channel.onmessage = (event) => {
      // Page scripts may send arbitrary channel traffic; only authenticated frames are handled.
      this.receive(event.data).catch(() => {});
    };
  }

  static async connect(pairing: string, url: string): Promise<GitHttpWebBridge> {
    const bridge = new GitHttpWebBridge(await importKey(pairing), url);
    try {
      await bridge.handshake();
      return bridge;
    } catch (error) {
      bridge.dispose();
      throw error;
    }
  }

  private handshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.helloResolve = undefined;
        reject(new RemotishError('OFFLINE', 'Git HTTP userscript did not answer.'));
      }, 5_000);
      this.helloResolve = (sessionId) => {
        clearTimeout(timer);
        this.helloResolve = undefined;
        this.sessionId = sessionId;
        resolve();
      };
      this.send({ version: 1, kind: 'hello-request', hostId: this.hostId, id: this.helloId }).catch(
        (error: unknown) => {
          clearTimeout(timer);
          this.helloResolve = undefined;
          reject(error);
        },
      );
    });
  }

  async request(request: GitHttpRequest): Promise<GitHttpResponse> {
    if (this.disposed) {
      throw new GitHttpNotDispatchedError('OFFLINE', 'Git HTTP bridge is closed.');
    }
    const sessionId = this.sessionId;
    if (!sessionId) {
      throw new GitHttpNotDispatchedError('OFFLINE', 'Git HTTP userscript session is unavailable.');
    }
    if (this.pending.size >= MAX_PENDING) {
      throw new GitHttpNotDispatchedError('RATE_LIMITED', 'Too many Git HTTP bridge requests.');
    }
    const target = new URL(request.url);
    const configured = new URL(this.url);
    if (
      target.origin !== configured.origin ||
      !target.pathname.startsWith(`${configured.pathname}/`)
    ) {
      throw new GitHttpNotDispatchedError(
        'INVALID_REQUEST',
        'Git HTTP request left the configured origin.',
      );
    }
    if (request.signal?.aborted) {
      throw new GitHttpNotDispatchedError('CANCELLED', 'Git HTTP request cancelled.');
    }
    const id = randomId();
    let packet: string;
    try {
      packet = await encrypt(this.key, {
        version: 1,
        kind: 'request',
        hostId: this.hostId,
        id,
        sessionId,
        url: request.url,
        method: request.method,
        headers: { ...request.headers },
        body: encodeBytes(request.body),
      });
    } catch (error) {
      throw new GitHttpNotDispatchedError(
        error instanceof RemotishError ? error.code : 'UNKNOWN',
        'Git HTTP bridge request was not sent.',
        { cause: error },
      );
    }
    if (request.signal?.aborted) {
      throw new GitHttpNotDispatchedError('CANCELLED', 'Git HTTP request cancelled.');
    }
    if (this.disposed) {
      throw new GitHttpNotDispatchedError('OFFLINE', 'Git HTTP bridge is closed.');
    }
    return new Promise<GitHttpResponse>((resolve, reject) => {
      const finish = (error?: RemotishError, value?: GitHttpResponse) => {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', cancel);
        this.pending.delete(id);
        if (error) {
          reject(error);
        } else if (value) {
          resolve(value);
        }
      };
      const cancel = () => {
        this.send({ version: 1, kind: 'cancel', hostId: this.hostId, id, sessionId }).catch(
          () => {},
        );
        finish(new RemotishError('CANCELLED', 'Git HTTP request cancelled.'));
      };
      const timer = setTimeout(
        () => finish(new RemotishError('OFFLINE', 'Git HTTP bridge timed out.')),
        TIMEOUT_MS,
      );
      this.pending.set(id, {
        resolve: (value) => finish(undefined, value),
        reject: (error) => finish(error),
      });
      request.signal?.addEventListener('abort', cancel, { once: true });
      try {
        this.channel.postMessage(packet);
      } catch (error) {
        finish(
          new GitHttpNotDispatchedError('OFFLINE', 'Git HTTP bridge request was not sent.', {
            cause: error,
          }),
        );
      }
    });
  }

  private async send(frame: Parameters<typeof encrypt>[1]): Promise<void> {
    if (!this.disposed) {
      this.channel.postMessage(await encrypt(this.key, frame));
    }
  }

  private async receive(raw: unknown): Promise<void> {
    const frame = await decrypt(this.key, raw);
    if (frame.hostId !== this.hostId || this.disposed) {
      return;
    }
    if (frame.kind === 'hello' && frame.id === this.helloId) {
      this.helloResolve?.(frame.sessionId);
      return;
    }
    if (frame.kind === 'hello-request' || frame.sessionId !== this.sessionId) {
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) {
      return;
    }
    if (frame.kind === 'response') {
      try {
        pending.resolve({
          status: frame.status,
          headers: frame.headers,
          body: decodeBytes(frame.body),
        });
      } catch {
        pending.reject(new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP bridge response.'));
      }
    } else if (frame.kind === 'failure') {
      pending.reject(new RemotishError(frame.code, 'Git HTTP bridge request failed.'));
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.channel.onmessage = null;
    this.channel.close();
    for (const pending of this.pending.values()) {
      pending.reject(new RemotishError('OFFLINE', 'Git HTTP bridge closed.'));
    }
    this.pending.clear();
  }
}
