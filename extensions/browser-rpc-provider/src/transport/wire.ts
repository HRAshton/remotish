import { RemotishError } from '@remotish/adapter-sdk';

const BROWSER_RPC_TRANSPORT_VERSION = 1 as const;
const MAX_FRAME_BYTES = 24 * 1024 * 1024;
export const MAX_PACKET_CHARS = 32 * 1024 * 1024;

export type BrowserRpcFrame =
  | { readonly version: 1; readonly kind: 'hello'; readonly hostId: string }
  | {
      readonly version: 1;
      readonly kind: 'register';
      readonly hostId: string;
      readonly endpointId: string;
      readonly counter: number;
      readonly origin: string;
      readonly target: string;
      readonly session: unknown;
    }
  | {
      readonly version: 1;
      readonly kind: 'heartbeat' | 'disconnect';
      readonly hostId: string;
      readonly endpointId: string;
      readonly counter: number;
    }
  | {
      readonly version: 1;
      readonly kind: 'request';
      readonly hostId: string;
      readonly endpointId: string;
      readonly requestId: string;
      readonly request: unknown;
    }
  | {
      readonly version: 1;
      readonly kind: 'response';
      readonly hostId: string;
      readonly endpointId: string;
      readonly requestId: string;
      readonly response: unknown;
    }
  | {
      readonly version: 1;
      readonly kind: 'cancel';
      readonly hostId: string;
      readonly endpointId: string;
      readonly requestId: string;
    };

interface EncryptedPacket {
  readonly version: 1;
  readonly iv: string;
  readonly ciphertext: string;
}

/** Import a customer-generated 256-bit key; never log or persist it outside SecretStorage. */
export async function importBridgeKey(value: unknown): Promise<CryptoKey> {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new RemotishError('INVALID_REQUEST', 'A 256-bit Browser RPC bridge key is required.');
  }
  const bytes = fromBase64Url(value);
  if (bytes.length !== 32 || toBase64Url(bytes) !== value) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Browser RPC bridge key.');
  }
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** A new random ID is used for every host, endpoint instance, and request. */
export function randomTransportId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function encryptFrame(key: CryptoKey, frame: BrowserRpcFrame): Promise<string> {
  const plaintext = new TextEncoder().encode(JSON.stringify(frame));
  if (plaintext.length > MAX_FRAME_BYTES) {
    throw new RemotishError('INVALID_REQUEST', 'Browser RPC message exceeds the size limit.');
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext),
  );
  const packet = JSON.stringify({
    version: BROWSER_RPC_TRANSPORT_VERSION,
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(ciphertext),
  } satisfies EncryptedPacket);
  if (packet.length > MAX_PACKET_CHARS) {
    throw new RemotishError('INVALID_REQUEST', 'Browser RPC packet exceeds the size limit.');
  }
  return packet;
}

/** Authentication fails closed; raw ciphertext and parser errors never enter diagnostics. */
export async function decryptFrame(key: CryptoKey, raw: unknown): Promise<BrowserRpcFrame> {
  if (typeof raw !== 'string' || raw.length > MAX_PACKET_CHARS) {
    throw malformed();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw malformed();
  }
  const packet = record(parsed, ['version', 'iv', 'ciphertext']);
  if (
    packet.version !== BROWSER_RPC_TRANSPORT_VERSION ||
    typeof packet.iv !== 'string' ||
    typeof packet.ciphertext !== 'string' ||
    !/^[A-Za-z0-9_-]{16}$/u.test(packet.iv) ||
    !/^[A-Za-z0-9_-]+$/u.test(packet.ciphertext)
  ) {
    throw malformed();
  }
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(packet.iv) },
      key,
      fromBase64Url(packet.ciphertext),
    );
  } catch {
    throw malformed();
  }
  if (plaintext.byteLength > MAX_FRAME_BYTES) {
    throw malformed();
  }
  try {
    return decodeFrame(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)));
  } catch {
    throw malformed();
  }
}

export function decodeFrame(value: unknown): BrowserRpcFrame {
  const base = record(value, [
    'version',
    'kind',
    'hostId',
    'endpointId',
    'counter',
    'requestId',
    'origin',
    'target',
    'session',
    'request',
    'response',
  ]);
  if (base.version !== BROWSER_RPC_TRANSPORT_VERSION) {
    throw malformed();
  }
  switch (base.kind) {
    case 'hello':
      exact(base, ['version', 'kind', 'hostId']);
      return { version: 1, kind: 'hello', hostId: id(base.hostId) };
    case 'register':
      exact(base, [
        'version',
        'kind',
        'hostId',
        'endpointId',
        'counter',
        'origin',
        'target',
        'session',
      ]);
      return {
        version: 1,
        kind: 'register',
        hostId: id(base.hostId),
        endpointId: id(base.endpointId),
        counter: sequence(base.counter),
        origin: text(base.origin),
        target: text(base.target),
        session: base.session,
      };
    case 'heartbeat':
    case 'disconnect':
      exact(base, ['version', 'kind', 'hostId', 'endpointId', 'counter']);
      return {
        version: 1,
        kind: base.kind,
        hostId: id(base.hostId),
        endpointId: id(base.endpointId),
        counter: sequence(base.counter),
      };
    case 'request':
      exact(base, ['version', 'kind', 'hostId', 'endpointId', 'requestId', 'request']);
      return {
        version: 1,
        kind: 'request',
        hostId: id(base.hostId),
        endpointId: id(base.endpointId),
        requestId: id(base.requestId),
        request: base.request,
      };
    case 'response':
      exact(base, ['version', 'kind', 'hostId', 'endpointId', 'requestId', 'response']);
      return {
        version: 1,
        kind: 'response',
        hostId: id(base.hostId),
        endpointId: id(base.endpointId),
        requestId: id(base.requestId),
        response: base.response,
      };
    case 'cancel':
      exact(base, ['version', 'kind', 'hostId', 'endpointId', 'requestId']);
      return {
        version: 1,
        kind: 'cancel',
        hostId: id(base.hostId),
        endpointId: id(base.endpointId),
        requestId: id(base.requestId),
      };
    default:
      throw malformed();
  }
}

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw malformed();
  }
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !allowed.includes(key))) {
    throw malformed();
  }
  return data;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw malformed();
  }
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/u.test(value)) {
    throw malformed();
  }
  return value;
}

function sequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw malformed();
  }
  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048) {
    throw malformed();
  }
  return value;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  let binary: string;
  try {
    binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  } catch {
    throw malformed();
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function malformed(): RemotishError {
  return new RemotishError('INVALID_REQUEST', 'Malformed Browser RPC transport message.');
}
