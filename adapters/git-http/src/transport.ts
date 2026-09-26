import { RemotishError, type RemotishErrorCode } from '@remotish/adapter-sdk';
import type {
  HttpClient,
  GitHttpRequest as IsomorphicRequest,
  PromiseFsClient,
} from 'isomorphic-git';

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** Only transport code with positive proof of no write may throw this error. */
export class GitHttpNotDispatchedError extends RemotishError {
  constructor(code: RemotishErrorCode, message: string, options?: { cause?: unknown }) {
    super(code, message, options);
  }
}

export interface GitHttpRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface GitHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface GitHttpAdapterOptions {
  readonly url: string;
  readonly author: { readonly name: string; readonly email: string };
  readonly request: (request: GitHttpRequest) => Promise<GitHttpResponse>;
  /** Optional heap-only filesystem supplied by a non-browser host. */
  readonly fs?: PromiseFsClient;
}

/** Restrict every Git request to one configured origin and repository path. */
export function validateGitUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTPS URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith('.git') ||
    url.pathname.includes('//') ||
    url.pathname.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new RemotishError('INVALID_REQUEST', 'Expected a credential-free HTTPS Git clone URL.');
  }
  return url.href;
}

async function collect(
  body: AsyncIterable<Uint8Array> | undefined,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const part of body ?? []) {
    if (signal?.aborted) {
      throw new RemotishError('CANCELLED', 'Git HTTP request cancelled.');
    }
    length += part.byteLength;
    if (length > limit) {
      throw new RemotishError('UNSUPPORTED', 'Git HTTP transfer exceeds the pilot size limit.');
    }
    parts.push(part);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

export function createGitHttpClient(
  options: GitHttpAdapterOptions,
  operationSignal?: AbortSignal,
  onReceivePackRequest?: () => void,
): HttpClient {
  const configured = new URL(validateGitUrl(options.url));
  return {
    async request(request: IsomorphicRequest) {
      const url = new URL(request.url);
      if (
        url.origin !== configured.origin ||
        !url.pathname.startsWith(`${configured.pathname}/`) ||
        (url.pathname !== `${configured.pathname}/info/refs` &&
          url.pathname !== `${configured.pathname}/git-upload-pack` &&
          url.pathname !== `${configured.pathname}/git-receive-pack`)
      ) {
        throw new RemotishError('INVALID_REQUEST', 'Git HTTP request left the configured origin.');
      }
      const signal = request.signal ?? operationSignal;
      const body = await collect(request.body, MAX_REQUEST_BYTES, signal);
      if (url.pathname === `${configured.pathname}/git-receive-pack` && request.method === 'POST') {
        onReceivePackRequest?.();
      }
      const response = await options.request({
        url: url.href,
        method: request.method ?? 'GET',
        headers: request.headers ?? {},
        body,
        ...(signal ? { signal } : {}),
      });
      if (response.body.byteLength > MAX_RESPONSE_BYTES) {
        throw new RemotishError('UNSUPPORTED', 'Git HTTP response exceeds the pilot size limit.');
      }
      return {
        url: url.href,
        method: request.method ?? 'GET',
        statusCode: response.status,
        statusMessage: String(response.status),
        headers: { ...response.headers },
        body: (async function* () {
          yield response.body;
        })(),
      };
    },
  };
}
