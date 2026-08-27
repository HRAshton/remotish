import { RemotishError, type RemotishErrorCode } from '@remotish/adapter-sdk';
import { isRecord, type JsonDecoder } from './http-json.js';

/** Supplies request headers, allowing adapters to inject authentication without core involvement. */
export type HeaderProvider = HeadersInit | (() => HeadersInit | Promise<HeadersInit>);

/** Default deadline for one remote HTTP operation, including response body consumption. */
const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 30_000;

/** Default maximum decoded JSON response bytes. */
const DEFAULT_HTTP_MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Default maximum raw file response bytes. */
const DEFAULT_HTTP_MAX_FILE_BYTES = 64 * 1024 * 1024;

const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

/** Construction options for the example HTTP client. */
export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly headers?: HeaderProvider;
  /** Request deadline in milliseconds. */
  readonly requestTimeoutMs?: number;
  /** Maximum bytes accepted for one JSON response. */
  readonly maxJsonResponseBytes?: number;
  /** Maximum bytes accepted for one file response. */
  readonly maxFileBytes?: number;
}

/**
 * Browser-safe HTTP transport for the example adapter protocol.
 *
 * JSON responses must pass an explicit decoder before callers receive typed values; binary reads
 * stay byte-oriented and network/HTTP failures are normalized to RemotishError.
 */
export class HttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxJsonResponseBytes: number;
  private readonly maxFileBytes: number;

  constructor(private readonly options: HttpClientOptions) {
    this.baseUrl = requireSecureBaseUrl(options.baseUrl, 'HTTP adapter baseUrl');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = requirePositiveInteger(
      options.requestTimeoutMs ?? DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    );
    this.maxJsonResponseBytes = requirePositiveInteger(
      options.maxJsonResponseBytes ?? DEFAULT_HTTP_MAX_JSON_RESPONSE_BYTES,
      'maxJsonResponseBytes',
    );
    this.maxFileBytes = requirePositiveInteger(
      options.maxFileBytes ?? DEFAULT_HTTP_MAX_FILE_BYTES,
      'maxFileBytes',
    );
  }

  async json<T>(
    path: string,
    decode: JsonDecoder<T>,
    init: RequestInit = {},
    allowedStatuses: readonly number[] = [],
  ): Promise<T> {
    return this.request(
      path,
      {
        ...init,
        headers: await this.mergeHeaders(init.headers, { Accept: 'application/json' }),
      },
      async (response) => {
        if (!response.ok && !allowedStatuses.includes(response.status)) {
          await throwHttpError(response);
        }
        return decode(await readJson(response, this.maxJsonResponseBytes, 'HTTP JSON response'));
      },
    );
  }

  async bytes(path: string, init: RequestInit = {}): Promise<Uint8Array> {
    return this.request(
      path,
      {
        ...init,
        headers: await this.mergeHeaders(init.headers, { Accept: 'application/octet-stream' }),
      },
      async (response) => {
        if (!response.ok) {
          await throwHttpError(response);
        }
        return readLimitedBytes(response, this.maxFileBytes, 'HTTP file response');
      },
    );
  }

  async sendJson<T>(
    path: string,
    method: 'POST' | 'DELETE',
    decode: JsonDecoder<T>,
    body?: unknown,
    allowedStatuses: readonly number[] = [],
    signal?: AbortSignal,
  ): Promise<T> {
    const headers = await this.mergeHeaders(undefined, {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    });
    return this.json(
      path,
      decode,
      {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      },
      allowedStatuses,
    );
  }

  async sendVoid(
    path: string,
    method: 'POST' | 'DELETE',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    const headers = await this.mergeHeaders(undefined, {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    });
    await this.request(
      path,
      {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      },
      async (response) => {
        if (!response.ok) {
          await throwHttpError(response);
        }
      },
    );
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    const externalSignal = init.signal ?? undefined;
    const request = createRequestSignal(externalSignal, this.requestTimeoutMs);
    let response: Response;

    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: request.signal,
      });
    } catch (error) {
      request.dispose();
      throw normalizeRequestFailure(error, externalSignal, request.timedOut, this.requestTimeoutMs);
    }

    try {
      return await consume(response);
    } catch (error) {
      if (error instanceof RemotishError) {
        throw error;
      }
      if (externalSignal?.aborted) {
        throw new RemotishError('CANCELLED', 'HTTP request was cancelled.', { cause: error });
      }
      if (request.timedOut()) {
        throw new RemotishError(
          'OFFLINE',
          `HTTP request timed out after ${this.requestTimeoutMs} ms.`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      request.dispose();
    }
  }

  private async mergeHeaders(
    local: HeadersInit | undefined,
    required: HeadersInit,
  ): Promise<Headers> {
    const headers = new Headers(await resolveHeaders(this.options.headers));
    new Headers(local).forEach((value, key) => {
      headers.set(key, value);
    });
    new Headers(required).forEach((value, key) => {
      headers.set(key, value);
    });
    return headers;
  }
}

async function resolveHeaders(
  provider: HeaderProvider | undefined,
): Promise<HeadersInit | undefined> {
  return typeof provider === 'function' ? provider() : provider;
}

async function throwHttpError(response: Response): Promise<never> {
  const message = await readErrorMessage(response);
  throw new RemotishError(codeForStatus(response.status), message ?? `HTTP ${response.status}.`);
}

async function readErrorMessage(response: Response): Promise<string | undefined> {
  const contentType = response.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      const body = await readJson(response, MAX_ERROR_RESPONSE_BYTES, 'HTTP error response');
      return isRecord(body) && typeof body.message === 'string' ? body.message : undefined;
    }
    const text = await readLimitedText(response, MAX_ERROR_RESPONSE_BYTES, 'HTTP error response');
    return text.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function readJson(response: Response, maxBytes: number, context: string): Promise<unknown> {
  const text = await readLimitedText(response, maxBytes, context);
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new RemotishError('UNKNOWN', `${context} was not valid JSON.`, { cause });
  }
}

async function readLimitedText(
  response: Response,
  maxBytes: number,
  context: string,
): Promise<string> {
  return new TextDecoder().decode(await readLimitedBytes(response, maxBytes, context));
}

async function readLimitedBytes(
  response: Response,
  maxBytes: number,
  context: string,
): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw responseTooLarge(context, maxBytes);
    }
  }

  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw responseTooLarge(context, maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function responseTooLarge(context: string, maxBytes: number): RemotishError {
  return new RemotishError(
    'UNSUPPORTED',
    `${context} exceeded the configured ${maxBytes}-byte limit.`,
  );
}

function createRequestSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  let didTimeOut = false;
  const abortFromExternal = (): void => controller.abort();

  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  }

  const timeout = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortFromExternal);
    },
  };
}

function normalizeRequestFailure(
  error: unknown,
  externalSignal: AbortSignal | undefined,
  timedOut: () => boolean,
  timeoutMs: number,
): RemotishError {
  if (externalSignal?.aborted) {
    return new RemotishError('CANCELLED', 'HTTP request was cancelled.', { cause: error });
  }
  if (timedOut()) {
    return new RemotishError('OFFLINE', `HTTP request timed out after ${timeoutMs} ms.`, {
      cause: error,
    });
  }
  if (isAbortError(error)) {
    return new RemotishError('CANCELLED', 'HTTP request was cancelled.', { cause: error });
  }
  return new RemotishError('OFFLINE', 'HTTP request failed before a response was received.', {
    cause: error,
  });
}

function requireSecureBaseUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new RemotishError('INVALID_REQUEST', `${label} must be an absolute URL.`, { cause });
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new RemotishError(
      'INVALID_REQUEST',
      `${label} must not contain credentials, a query string, or a fragment.`,
    );
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new RemotishError(
      'INVALID_REQUEST',
      `${label} must use HTTPS; plaintext HTTP is allowed only for loopback development hosts.`,
    );
  }
  return url.toString().replace(/\/+$/u, '');
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') {
    return true;
  }

  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: RegExp.exec returns null when hostname is not an IPv4 literal.
  if (!match) {
    return false;
  }
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function codeForStatus(status: number): RemotishErrorCode {
  if (status === 400) {
    return 'INVALID_REQUEST';
  }
  if (status === 401) {
    return 'UNAUTHORIZED';
  }
  if (status === 403) {
    return 'FORBIDDEN';
  }
  if (status === 404) {
    return 'NOT_FOUND';
  }
  if (status === 429) {
    return 'RATE_LIMITED';
  }
  if (status === 501) {
    return 'UNSUPPORTED';
  }
  return 'UNKNOWN';
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
