import { RemotishError } from '@remotish/adapter-sdk';
import { type BridgeFrame, decodeBridgeFrame } from './bridge-frame.js';

export type { BridgeFrame } from './bridge-frame.js';
export const CHANNEL = 'remotish-git-http-v1';
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_PACKET_CHARS = 24 * 1024 * 1024;

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

export function decodeBytes(value: string, limit = MAX_BODY_BYTES): Uint8Array<ArrayBuffer> {
  if (value.length > Math.ceil(limit / 3) * 4 + 4 || value.length % 4 !== 0) {
    throw invalidBytes();
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  for (let i = 0; i < value.length - padding; i += 1) {
    const code = value.charCodeAt(i);
    if (!isBase64Code(code)) {
      throw invalidBytes();
    }
  }
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw invalidBytes();
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
  const { iv, ciphertext } = decodePacket(raw);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      decodeBytes(ciphertext, MAX_PACKET_CHARS / 2),
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
  return decodeBridgeFrame(frame);
}

export function randomId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function decodePacket(raw: unknown): {
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly ciphertext: string;
} {
  if (typeof raw !== 'string' || raw.length > MAX_PACKET_CHARS) {
    throw invalidPacket();
  }
  let packet: unknown;
  try {
    packet = JSON.parse(raw);
  } catch {
    throw invalidPacket();
  }
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
    throw invalidPacket();
  }
  const data = packet as Record<string, unknown>;
  if (data.version !== 1 || typeof data.iv !== 'string' || typeof data.ciphertext !== 'string') {
    throw invalidPacket();
  }
  const iv = decodeBytes(data.iv);
  if (iv.length !== 12) {
    throw invalidPacket();
  }
  return { iv, ciphertext: data.ciphertext };
}

function isBase64Code(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47
  );
}

function invalidBytes(): RemotishError {
  return new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP bridge bytes.');
}

function invalidPacket(): RemotishError {
  return new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP bridge packet.');
}
