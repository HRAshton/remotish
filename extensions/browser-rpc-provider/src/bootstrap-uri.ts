import { RemotishError } from '@remotish/adapter-sdk';
import { normalizeBrowserRpcTarget } from './target.js';

export const BROWSER_RPC_BOOTSTRAP_SCHEME = 'remotish-rpc';

export interface BrowserRpcBootstrapRequest {
  readonly target: string;
  readonly branch?: string;
}

/** A bootstrap URI identifies an unresolved repository, never a canonical workspace. */
export function createBrowserRpcBootstrapUri(request: BrowserRpcBootstrapRequest): string {
  const target = normalizeBrowserRpcTarget(request.target);
  const branch = request.branch === undefined ? undefined : validateBranch(request.branch);
  const uri = `${BROWSER_RPC_BOOTSTRAP_SCHEME}://open/v1/${encodeText(target)}${branch === undefined ? '' : `?branch=${encodeText(branch)}`}`;
  if (uri.length > 8192) {
    throw invalidBootstrap();
  }
  return uri;
}

/** Decode only the versioned root form accepted through Code-OSS Web's `?folder=` parameter. */
export function decodeBrowserRpcBootstrapUri(value: unknown): BrowserRpcBootstrapRequest {
  const uri = decodeUriParts(value);
  const path = /^\/v1\/([A-Za-z0-9_-]+)$/u.exec(uri.path);
  if (
    uri.scheme !== BROWSER_RPC_BOOTSTRAP_SCHEME ||
    uri.authority !== 'open' ||
    uri.fragment !== '' ||
    !path
  ) {
    throw invalidBootstrap();
  }
  const target = decodeText(path[1] ?? '');
  let branch: string | undefined;
  if (uri.query) {
    if (!/^branch=[A-Za-z0-9_-]+$/u.test(uri.query)) {
      throw invalidBootstrap();
    }
    branch = validateBranch(decodeText(uri.query.slice('branch='.length)));
  }
  return {
    target: normalizeBrowserRpcTarget(target),
    ...(branch === undefined ? {} : { branch }),
  };
}

function validateBranch(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2048 ||
    value !== value.trim() ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw invalidBootstrap();
  }
  return value;
}

function encodeText(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function decodeText(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw invalidBootstrap();
  }
  let decoded: string;
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalidBootstrap();
  }
  if (encodeText(decoded) !== value) {
    throw invalidBootstrap();
  }
  return decoded;
}

interface BootstrapUriParts {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
}

function decodeUriParts(value: unknown): BootstrapUriParts {
  if (typeof value === 'string') {
    if (value.length > 8192) {
      throw invalidBootstrap();
    }
    let uri: URL;
    try {
      uri = new URL(value);
    } catch {
      throw invalidBootstrap();
    }
    if (uri.username || uri.password) {
      throw invalidBootstrap();
    }
    return {
      scheme: uri.protocol.slice(0, -1),
      authority: uri.host,
      path: uri.pathname,
      query: uri.search.slice(1),
      fragment: uri.hash.slice(1),
    };
  }
  if (!value || typeof value !== 'object') {
    throw invalidBootstrap();
  }
  const parts = value as Record<string, unknown>;
  if (
    typeof parts.scheme !== 'string' ||
    typeof parts.authority !== 'string' ||
    typeof parts.path !== 'string' ||
    typeof parts.query !== 'string' ||
    typeof parts.fragment !== 'string' ||
    parts.path.length + parts.query.length > 8192
  ) {
    throw invalidBootstrap();
  }
  return {
    scheme: parts.scheme,
    authority: parts.authority,
    path: parts.path,
    query: parts.query,
    fragment: parts.fragment,
  };
}

function invalidBootstrap(): RemotishError {
  return new RemotishError('INVALID_REQUEST', 'Invalid Browser RPC bootstrap URI.');
}
