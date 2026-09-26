import { normalizeRepoPath, RemotishError, type RemotishErrorCode } from '@remotish/adapter-sdk';
import { REMOTISH_RPC_VERSION, type RpcOperation } from './rpc-types.js';

export function encodeRpcBytes(bytes: Uint8Array): { readonly base64: string } {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return { base64: btoa(binary) };
}

export function decodeRpcBytes(value: unknown): Uint8Array {
  const data = record(value, 'bytes', ['base64']);
  const base64 = string(data.base64, 'bytes.base64');
  if (base64.length % 4 !== 0) {
    throw invalid('bytes.base64');
  }
  for (let index = 0; index < base64.length; index += 1) {
    const code = base64.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47 ||
      (code === 61 && index >= base64.length - 2);
    if (!valid) {
      throw invalid('bytes.base64');
    }
  }
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw invalid('bytes.base64');
  }
  if (btoa(binary) !== base64) {
    throw invalid('bytes.base64');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function repoPath(value: unknown): string {
  const input = string(value, 'path');
  try {
    if (normalizeRepoPath(input) === input) {
      return input;
    }
  } catch {
    // Reject below with the stable protocol validation error.
  }
  throw invalid('path');
}

export function record(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(label);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw invalid(label);
  }
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !keys.includes(key))) {
    throw invalid(label);
  }
  return data;
}

export function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw invalid(label);
  }
  return value;
}

export function string(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw invalid(label);
  }
  return value;
}

export function nonempty(value: unknown, label: string): string {
  const result = string(value, label);
  if (!result) {
    throw invalid(label);
  }
  return result;
}

export function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
}

export function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw invalid(label);
  }
  return value;
}

export function optionalBoolean(value: unknown, label: string): boolean | undefined {
  return value === undefined ? undefined : boolean(value, label);
}

export function requireVersion(value: unknown): void {
  if (value !== REMOTISH_RPC_VERSION) {
    throw invalid('protocol version');
  }
}

export function isOperation(value: string): value is RpcOperation {
  return [
    'getRepository',
    'readDirectory',
    'readFile',
    'getBranches',
    'getCommits',
    'getCommitChanges',
    'commit',
    'createBranch',
    'deleteBranch',
  ].includes(value);
}

export function isErrorCode(value: string): value is RemotishErrorCode {
  return [
    'NOT_FOUND',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'RATE_LIMITED',
    'OFFLINE',
    'UNSUPPORTED',
    'INVALID_REQUEST',
    'CANCELLED',
    'UNKNOWN',
  ].includes(value);
}

export function errorMessage(code: RemotishErrorCode): string {
  return `Remote operation failed (${code}).`;
}

export function invalid(label: string): RemotishError {
  return new RemotishError('UNKNOWN', `Invalid Remotish RPC ${label}.`);
}
