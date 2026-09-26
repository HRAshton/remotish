import type { GitHttpRequest, GitHttpResponse } from '@remotish/adapter-git-http';
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
  private readonly pending = new Map<string, Pending>();
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
    return new GitHttpWebBridge(await importKey(pairing), url);
  }

  async request(request: GitHttpRequest): Promise<GitHttpResponse> {
    if (this.disposed) {
      throw new RemotishError('OFFLINE', 'Git HTTP bridge is closed.');
    }
    if (this.pending.size >= MAX_PENDING) {
      throw new RemotishError('RATE_LIMITED', 'Too many Git HTTP bridge requests.');
    }
    const target = new URL(request.url);
    const configured = new URL(this.url);
    if (
      target.origin !== configured.origin ||
      !target.pathname.startsWith(`${configured.pathname}/`)
    ) {
      throw new RemotishError('INVALID_REQUEST', 'Git HTTP request left the configured origin.');
    }
    if (request.signal?.aborted) {
      throw new RemotishError('CANCELLED', 'Git HTTP request cancelled.');
    }
    const id = randomId();
    const packet = await encrypt(this.key, {
      version: 1,
      kind: 'request',
      hostId: this.hostId,
      id,
      url: request.url,
      method: request.method,
      headers: { ...request.headers },
      body: encodeBytes(request.body),
    });
    if (request.signal?.aborted) {
      throw new RemotishError('CANCELLED', 'Git HTTP request cancelled.');
    }
    if (this.disposed) {
      throw new RemotishError('OFFLINE', 'Git HTTP bridge is closed.');
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
        this.send({ version: 1, kind: 'cancel', hostId: this.hostId, id }).catch(() => {});
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
      this.channel.postMessage(packet);
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
