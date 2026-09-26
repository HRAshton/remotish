import {
  type BridgeFrame,
  CHANNEL,
  decodeBytes,
  decrypt,
  encodeBytes,
  encrypt,
  importKey,
  MAX_BODY_BYTES,
  randomId,
} from './bridge-wire.js';

const TOKEN_KEY = 'remotish.gitHttp.token.v1';
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ACTIVE = 8;
const MAX_SEEN = 4096;

export interface GitHttpUserscriptConfig {
  readonly codeOrigin: string;
  readonly gitUrl: string;
  readonly redirectProbeUrl: string;
  readonly pairingKey: string;
}

interface GmResponse {
  readonly status: number;
  readonly finalUrl?: string;
  readonly response: ArrayBuffer;
  readonly responseHeaders: string;
}
interface GmHandle {
  abort(): void;
}
interface GmDetails {
  readonly method: string;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly data?: ArrayBuffer;
  readonly responseType: 'arraybuffer';
  readonly redirect: 'manual';
  readonly anonymous?: boolean;
  readonly timeout: number;
  readonly onload: (value: GmResponse) => void;
  readonly onerror: () => void;
  readonly ontimeout: () => void;
  readonly onabort: () => void;
  readonly onprogress?: (value: { readonly loaded: number }) => void;
  readonly onredirect?: () => void;
}

declare const GM_info: { readonly sandboxMode: string; readonly scriptHandler: string };
declare const GM_getValue: (name: string) => unknown | Promise<unknown>;
declare const GM_setValue: (name: string, value: string) => void | Promise<void>;
declare const GM_registerMenuCommand: (name: string, callback: () => void) => void;
declare const GM_xmlhttpRequest: (details: GmDetails) => GmHandle;

export async function startGitHttpUserscript(config: GitHttpUserscriptConfig): Promise<void> {
  validateEnvironment(config);
  await verifyRedirectControl(config);
  const runtime = new UserscriptBridge(config, await importKey(config.pairingKey));
  runtime.start();
}

class UserscriptBridge {
  private readonly sessionId = randomId();
  private readonly channel = new BroadcastChannel(CHANNEL);
  private readonly seen = new Set<string>();
  private readonly active = new Map<string, GmHandle>();

  constructor(
    private readonly config: GitHttpUserscriptConfig,
    private readonly key: CryptoKey,
  ) {}

  start(): void {
    registerTokenCommand();
    this.channel.onmessage = (event) => {
      // Arbitrary page/channel traffic is expected; only authenticated valid frames are actionable.
      this.handleMessage(event.data).catch(() => {});
    };
    globalThis.addEventListener('pagehide', () => this.dispose(), { once: true });
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const frame = await decrypt(this.key, raw);
    if (frame.kind === 'hello-request') {
      await this.send({
        version: 1,
        kind: 'hello',
        hostId: frame.hostId,
        id: frame.id,
        sessionId: this.sessionId,
      });
      return;
    }
    if (frame.sessionId !== this.sessionId) {
      return;
    }
    const requestKey = `${frame.hostId}:${frame.id}`;
    if (frame.kind === 'cancel') {
      this.recordCancellation(requestKey);
      return;
    }
    if (frame.kind !== 'request' || this.seen.has(requestKey)) {
      return;
    }
    if (this.seen.size >= MAX_SEEN || this.active.size >= MAX_ACTIVE) {
      await this.fail(frame, 'UNSUPPORTED');
      return;
    }
    this.seen.add(requestKey);
    await this.handleRequest(frame, requestKey);
  }

  private async handleRequest(
    frame: Extract<BridgeFrame, { kind: 'request' }>,
    requestKey: string,
  ): Promise<void> {
    if (!allowedUrl(this.config.gitUrl, frame.url) || !['GET', 'POST'].includes(frame.method)) {
      await this.fail(frame, 'INVALID_REQUEST');
      return;
    }
    let body: Uint8Array;
    let headers: Record<string, string>;
    try {
      body = decodeBytes(frame.body);
      headers = safeHeaders(frame.headers);
    } catch {
      await this.fail(frame, 'INVALID_REQUEST');
      return;
    }
    const token = await GM_getValue(TOKEN_KEY);
    if (typeof token !== 'string' || !token || /[\r\n]/u.test(token)) {
      await this.fail(frame, 'UNAUTHORIZED');
      return;
    }
    this.dispatch(frame, requestKey, body, headers, token);
  }

  private dispatch(
    frame: Extract<BridgeFrame, { kind: 'request' }>,
    requestKey: string,
    body: Uint8Array,
    headers: Record<string, string>,
    token: string,
  ): void {
    const payload = new ArrayBuffer(body.byteLength);
    new Uint8Array(payload).set(body);
    let settled = false;
    const fail = (code: 'OFFLINE' | 'UNSUPPORTED') => {
      if (settled) {
        return;
      }
      settled = true;
      this.active.delete(requestKey);
      // Once the privileged request is settled, a closed channel cannot be recovered here.
      this.fail(frame, code).catch(() => {});
    };
    const handle = GM_xmlhttpRequest({
      method: frame.method,
      url: frame.url,
      headers: { ...headers, Authorization: `Bearer ${token}` },
      ...(frame.method === 'POST' ? { data: payload } : {}),
      responseType: 'arraybuffer',
      redirect: 'manual',
      anonymous: true,
      timeout: REQUEST_TIMEOUT_MS,
      onprogress: (progress) => {
        if (progress.loaded > MAX_BODY_BYTES) {
          handle.abort();
        }
      },
      onredirect: () => handle.abort(),
      onload: (response) => {
        if (settled) {
          return;
        }
        if (response.finalUrl !== frame.url || (response.status >= 300 && response.status < 400)) {
          fail('OFFLINE');
          return;
        }
        if (
          !(response.response instanceof ArrayBuffer) ||
          response.response.byteLength > MAX_BODY_BYTES
        ) {
          fail('UNSUPPORTED');
          return;
        }
        settled = true;
        this.active.delete(requestKey);
        this.send({
          version: 1,
          kind: 'response',
          hostId: frame.hostId,
          id: frame.id,
          sessionId: this.sessionId,
          status: response.status,
          headers: parseHeaders(response.responseHeaders),
          body: encodeBytes(new Uint8Array(response.response)),
        }).catch(() => {
          // A response cannot be retried safely after the privileged request has completed.
        });
      },
      onerror: () => fail('OFFLINE'),
      ontimeout: () => fail('OFFLINE'),
      onabort: () => fail('OFFLINE'),
    });
    this.active.set(requestKey, handle);
  }

  private recordCancellation(requestKey: string): void {
    if (this.seen.size < MAX_SEEN) {
      this.seen.add(requestKey);
    }
    this.active.get(requestKey)?.abort();
  }

  private async fail(
    frame: Extract<BridgeFrame, { kind: 'request' }> | Extract<BridgeFrame, { kind: 'failure' }>,
    code: Extract<BridgeFrame, { kind: 'failure' }>['code'],
  ): Promise<void> {
    await this.send({
      version: 1,
      kind: 'failure',
      hostId: frame.hostId,
      id: frame.id,
      sessionId: this.sessionId,
      code,
    });
  }

  private async send(frame: BridgeFrame): Promise<void> {
    this.channel.postMessage(await encrypt(this.key, frame));
  }

  private dispose(): void {
    for (const request of this.active.values()) {
      request.abort();
    }
    this.active.clear();
    this.channel.close();
  }
}

function verifyRedirectControl(config: GitHttpUserscriptConfig): Promise<void> {
  if (new URL(config.redirectProbeUrl).origin !== config.codeOrigin) {
    return Promise.reject(new Error('Invalid redirect probe origin.'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (valid: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      valid
        ? resolve()
        : reject(new Error('GM_xmlhttpRequest did not prove manual redirect control.'));
    };
    GM_xmlhttpRequest({
      method: 'GET',
      url: config.redirectProbeUrl,
      responseType: 'arraybuffer',
      redirect: 'manual',
      anonymous: true,
      timeout: 10_000,
      onload: (response) =>
        finish(
          response.status >= 300 &&
            response.status < 400 &&
            response.finalUrl === config.redirectProbeUrl,
        ),
      onerror: () => finish(false),
      ontimeout: () => finish(false),
      onabort: () => finish(false),
      onredirect: () => finish(false),
    });
  });
}

function validateEnvironment(config: GitHttpUserscriptConfig): void {
  if (
    globalThis.location.origin !== config.codeOrigin ||
    GM_info.sandboxMode !== 'dom' ||
    GM_info.scriptHandler !== 'Tampermonkey'
  ) {
    throw new Error('Git HTTP bridge requires Tampermonkey isolated DOM sandbox on Code-OSS.');
  }
  if (
    new URL(config.gitUrl).protocol !== 'https:' ||
    !config.gitUrl.endsWith('.git') ||
    !/^[A-Za-z0-9_-]{43}$/u.test(config.pairingKey)
  ) {
    throw new Error('Configure the Git HTTP bridge before use.');
  }
}

function registerTokenCommand(): void {
  GM_registerMenuCommand('Set Git HTTP bearer token', () => {
    const value = globalThis.prompt('Bearer token for the configured Git origin');
    if (value && !/[\r\n]/u.test(value)) {
      Promise.resolve(GM_setValue(TOKEN_KEY, value)).catch(() => {
        console.error('Could not store the Git HTTP token.');
      });
    }
  });
}

function allowedUrl(gitUrl: string, raw: string): boolean {
  try {
    const base = new URL(gitUrl);
    const url = new URL(raw);
    return (
      url.origin === base.origin &&
      (url.pathname === `${base.pathname}/info/refs` ||
        url.pathname === `${base.pathname}/git-upload-pack` ||
        url.pathname === `${base.pathname}/git-receive-pack`) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function safeHeaders(input: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    const key = name.toLowerCase();
    if (!['accept', 'content-type', 'git-protocol'].includes(key) || /[\r\n]/u.test(value)) {
      throw new Error('Invalid Git HTTP request header.');
    }
    headers[name] = value;
  }
  return headers;
}

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/u)) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (['content-type', 'content-length', 'git-protocol'].includes(key) && value.length <= 4096) {
      headers[key] = value;
    }
  }
  return headers;
}
