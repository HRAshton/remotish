import { RemotishError } from '@remotish/adapter-sdk';

export const CHANNEL = 'remotish-git-http-v1';
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_PACKET_CHARS = 24 * 1024 * 1024;

export type BridgeFrame =
  | {
      readonly version: 1;
      readonly kind: 'request';
      readonly hostId: string;
      readonly id: string;
      readonly url: string;
      readonly method: string;
      readonly headers: Record<string, string>;
      readonly body: string;
    }
  | {
      readonly version: 1;
      readonly kind: 'response';
      readonly hostId: string;
      readonly id: string;
      readonly status: number;
      readonly headers: Record<string, string>;
      readonly body: string;
    }
  | {
      readonly version: 1;
      readonly kind: 'failure';
      readonly hostId: string;
      readonly id: string;
      readonly code:
        | 'OFFLINE'
        | 'UNAUTHORIZED'
        | 'FORBIDDEN'
        | 'UNSUPPORTED'
        | 'INVALID_REQUEST'
        | 'UNKNOWN';
    }
  | { readonly version: 1; readonly kind: 'cancel'; readonly hostId: string; readonly id: string };

export function encodeBytes(bytes: Uint8Array, limit = MAX_BODY_BYTES): string {
  if (bytes.byteLength > limit) {
    throw new RemotishError('UNSUPPORTED', 'Git HTTP bridge body is too large.');
  }
  let value = '';
  for (let i = 0; i < bytes.length; i += 24_000) {
    value += btoa(String.fromCharCode(...bytes.subarray(i, i + 24_000)));
  }
  return value;
}

export function decodeBytes(value: string, limit = MAX_BODY_BYTES): Uint8Array {
  if (value.length > Math.ceil(limit / 3) * 4 + 4 || value.length % 4 !== 0) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP bridge bytes.');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  for (let i = 0; i < value.length - padding; i += 1) {
    const code = value.charCodeAt(i);
    if (
      !(
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 47
      )
    ) {
      throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP bridge bytes.');
    }
  }
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP bridge bytes.');
  }
  if (decoded.length > limit) {
    throw new RemotishError('UNSUPPORTED', 'Git HTTP bridge body is too large.');
  }
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

export async function importKey(value: string): Promise<CryptoKey> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP bridge key.');
  }
  const raw = decodeBytes(`${value.replaceAll('-', '+').replaceAll('_', '/')}=`);
  if (raw.length !== 32) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP bridge key.');
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(key: CryptoKey, frame: BridgeFrame): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(frame));
  if (bytes.byteLength > MAX_PACKET_CHARS / 2) {
    throw new RemotishError('UNSUPPORTED', 'Git HTTP bridge frame is too large.');
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes),
  );
  const packet = JSON.stringify({
    version: 1,
    iv: encodeBytes(iv),
    ciphertext: encodeBytes(ciphertext, MAX_PACKET_CHARS / 2),
  });
  if (packet.length > MAX_PACKET_CHARS) {
    throw new RemotishError('UNSUPPORTED', 'Git HTTP bridge frame is too large.');
  }
  return packet;
}

export async function decrypt(key: CryptoKey, raw: unknown): Promise<BridgeFrame> {
  if (typeof raw !== 'string' || raw.length > MAX_PACKET_CHARS) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP bridge packet.');
  }
  let packet: unknown;
  try {
    packet = JSON.parse(raw);
  } catch {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP bridge packet.');
  }
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP bridge packet.');
  }
  const data = packet as Record<string, unknown>;
  if (data.version !== 1 || typeof data.iv !== 'string' || typeof data.ciphertext !== 'string') {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP bridge packet.');
  }
  const iv = decodeBytes(data.iv);
  if (iv.length !== 12) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP bridge packet.');
  }
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      decodeBytes(data.ciphertext, MAX_PACKET_CHARS / 2),
    );
  } catch {
    throw new RemotishError('INVALID_REQUEST', 'Unauthenticated Git HTTP bridge packet.');
  }
  let frame: unknown;
  try {
    frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP bridge frame.');
  }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP bridge frame.');
  }
  const fields = frame as Record<string, unknown>;
  if (
    fields.version !== 1 ||
    typeof fields.kind !== 'string' ||
    typeof fields.hostId !== 'string' ||
    typeof fields.id !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(fields.hostId) ||
    !/^[0-9a-f]{32}$/u.test(fields.id)
  ) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP bridge frame.');
  }
  if (fields.kind === 'cancel') {
    return { version: 1, kind: 'cancel', hostId: fields.hostId, id: fields.id };
  }
  if (fields.kind === 'failure' && isErrorCode(fields.code)) {
    return { version: 1, kind: 'failure', hostId: fields.hostId, id: fields.id, code: fields.code };
  }
  if (
    fields.kind === 'request' &&
    typeof fields.url === 'string' &&
    typeof fields.method === 'string' &&
    typeof fields.body === 'string' &&
    isHeaders(fields.headers)
  ) {
    return {
      version: 1,
      kind: 'request',
      hostId: fields.hostId,
      id: fields.id,
      url: fields.url,
      method: fields.method,
      headers: fields.headers,
      body: fields.body,
    };
  }
  if (
    fields.kind === 'response' &&
    typeof fields.status === 'number' &&
    Number.isInteger(fields.status) &&
    fields.status >= 100 &&
    fields.status <= 599 &&
    typeof fields.body === 'string' &&
    isHeaders(fields.headers)
  ) {
    return {
      version: 1,
      kind: 'response',
      hostId: fields.hostId,
      id: fields.id,
      status: fields.status,
      headers: fields.headers,
      body: fields.body,
    };
  }
  throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP bridge frame.');
}

function isHeaders(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length <= 32 &&
    Object.entries(value).every(
      ([key, entry]) => typeof entry === 'string' && key.length <= 64 && entry.length <= 4096,
    )
  );
}

function isErrorCode(value: unknown): value is Extract<BridgeFrame, { kind: 'failure' }>['code'] {
  return (
    value === 'OFFLINE' ||
    value === 'UNAUTHORIZED' ||
    value === 'FORBIDDEN' ||
    value === 'UNSUPPORTED' ||
    value === 'INVALID_REQUEST' ||
    value === 'UNKNOWN'
  );
}

export function randomId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
