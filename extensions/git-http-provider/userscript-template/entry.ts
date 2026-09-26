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
} from '../src/bridge-wire.js';

// Copy this file and metadata.txt into ignored local/ before configuring customer values.
const codeOrigin = 'https://code.example.invalid';
const gitUrl = 'https://git.example.invalid/scm/PRJ/repo.git';
const redirectProbeUrl = 'https://code.example.invalid/remotish-git-redirect-probe';
const pairingKey = 'REPLACE_WITH_YOUR_OWN_43_CHARACTER_BASE64URL_KEY';
const TOKEN_KEY = 'remotish.gitHttp.pilotToken.v1';
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ACTIVE = 8;
const MAX_SEEN = 4096;

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

function allowedUrl(raw: string): boolean {
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

/** A credential-free 302 probe must remain a 302 at the original URL. */
export function verifyRedirectControl(): Promise<void> {
  if (new URL(redirectProbeUrl).origin !== codeOrigin) {
    return Promise.reject(new Error('Invalid redirect probe origin.'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (valid: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (valid) {
        resolve();
      } else {
        reject(new Error('GM_xmlhttpRequest did not prove manual redirect control.'));
      }
    };
    GM_xmlhttpRequest({
      method: 'GET',
      url: redirectProbeUrl,
      responseType: 'arraybuffer',
      redirect: 'manual',
      anonymous: true,
      timeout: 10_000,
      onload: (response) =>
        finish(
          response.status >= 300 && response.status < 400 && response.finalUrl === redirectProbeUrl,
        ),
      onerror: () => finish(false),
      ontimeout: () => finish(false),
      onabort: () => finish(false),
      onredirect: () => finish(false),
    });
  });
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

async function main(): Promise<void> {
  if (
    globalThis.location.origin !== codeOrigin ||
    GM_info.sandboxMode !== 'dom' ||
    GM_info.scriptHandler !== 'Tampermonkey'
  ) {
    throw new Error('Git HTTP bridge requires Tampermonkey isolated DOM sandbox on Code-OSS.');
  }
  if (
    new URL(gitUrl).protocol !== 'https:' ||
    !gitUrl.endsWith('.git') ||
    !/^[A-Za-z0-9_-]{43}$/u.test(pairingKey)
  ) {
    throw new Error('Configure the Git HTTP bridge before use.');
  }
  await verifyRedirectControl();
  const key = await importKey(pairingKey);
  const sessionId = randomId();
  const channel = new BroadcastChannel(CHANNEL);
  const seen = new Set<string>();
  const active = new Map<string, GmHandle>();
  const send = async (frame: BridgeFrame): Promise<void> => {
    channel.postMessage(await encrypt(key, frame));
  };

  GM_registerMenuCommand('Set Git HTTP pilot bearer token', () => {
    const value = globalThis.prompt('Bearer token for the configured Git origin');
    if (value && !/[\r\n]/u.test(value)) {
      Promise.resolve(GM_setValue(TOKEN_KEY, value)).catch(() => {
        console.error('Could not store the Git HTTP pilot token.');
      });
    }
  });

  channel.onmessage = (event) => {
    const handle = async () => {
      const frame = await decrypt(key, event.data);
      if (frame.kind === 'hello-request') {
        await send({ version: 1, kind: 'hello', hostId: frame.hostId, id: frame.id, sessionId });
        return;
      }
      if (frame.sessionId !== sessionId) {
        return;
      }
      const requestKey = `${frame.hostId}:${frame.id}`;
      if (frame.kind === 'cancel') {
        if (seen.size < MAX_SEEN) {
          seen.add(requestKey);
        }
        active.get(requestKey)?.abort();
        return;
      }
      if (frame.kind !== 'request' || seen.has(requestKey)) {
        return;
      }
      if (seen.size >= MAX_SEEN || active.size >= MAX_ACTIVE) {
        await send({
          version: 1,
          kind: 'failure',
          hostId: frame.hostId,
          id: frame.id,
          sessionId,
          code: 'UNSUPPORTED',
        });
        return;
      }
      seen.add(requestKey);
      if (!allowedUrl(frame.url) || !['GET', 'POST'].includes(frame.method)) {
        await send({
          version: 1,
          kind: 'failure',
          hostId: frame.hostId,
          id: frame.id,
          sessionId,
          code: 'INVALID_REQUEST',
        });
        return;
      }
      let body: Uint8Array;
      let headers: Record<string, string>;
      try {
        body = decodeBytes(frame.body);
        headers = safeHeaders(frame.headers);
      } catch {
        await send({
          version: 1,
          kind: 'failure',
          hostId: frame.hostId,
          id: frame.id,
          sessionId,
          code: 'INVALID_REQUEST',
        });
        return;
      }
      const token = await GM_getValue(TOKEN_KEY);
      if (typeof token !== 'string' || !token || /[\r\n]/u.test(token)) {
        await send({
          version: 1,
          kind: 'failure',
          hostId: frame.hostId,
          id: frame.id,
          sessionId,
          code: 'UNAUTHORIZED',
        });
        return;
      }
      const payload = new ArrayBuffer(body.byteLength);
      new Uint8Array(payload).set(body);
      let settled = false;
      const fail = async (code: 'OFFLINE' | 'UNSUPPORTED') => {
        if (settled) {
          return;
        }
        settled = true;
        active.delete(requestKey);
        await send({
          version: 1,
          kind: 'failure',
          hostId: frame.hostId,
          id: frame.id,
          sessionId,
          code,
        });
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
        onredirect: () => {
          handle.abort();
        },
        onload: (response) => {
          if (settled) {
            return;
          }
          if (
            response.finalUrl !== frame.url ||
            (response.status >= 300 && response.status < 400)
          ) {
            fail('OFFLINE').catch(() => {});
            return;
          }
          if (
            !(response.response instanceof ArrayBuffer) ||
            response.response.byteLength > MAX_BODY_BYTES
          ) {
            fail('UNSUPPORTED').catch(() => {});
            return;
          }
          settled = true;
          active.delete(requestKey);
          send({
            version: 1,
            kind: 'response',
            hostId: frame.hostId,
            id: frame.id,
            sessionId,
            status: response.status,
            headers: parseHeaders(response.responseHeaders),
            body: encodeBytes(new Uint8Array(response.response)),
          }).catch(() => {});
        },
        onerror: () => {
          fail('OFFLINE').catch(() => {});
        },
        ontimeout: () => {
          fail('OFFLINE').catch(() => {});
        },
        onabort: () => {
          fail('OFFLINE').catch(() => {});
        },
      });
      active.set(requestKey, handle);
    };
    // Unauthenticated page traffic is ignored without exposing bridge details.
    handle().catch(() => {});
  };
  globalThis.addEventListener(
    'pagehide',
    () => {
      for (const request of active.values()) {
        request.abort();
      }
      channel.close();
    },
    { once: true },
  );
}

main().catch(() => {
  console.error(
    'Git HTTP userscript did not start. Check the local redirect probe and bridge configuration.',
  );
});
