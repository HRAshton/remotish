import { RemotishError } from '@remotish/adapter-sdk';
import { isRecord, type JsonDecoder } from './github-json.js';
import type { GitHubAdapterOptions } from './types.js';

/** Default deadline for one GitHub operation, including response body consumption. */
const DEFAULT_GITHUB_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Default maximum GitHub response size. Git blob payloads are base64 JSON, so this is larger than
 * the HTTP example adapter's JSON limit while still bounding one extension-host allocation.
 */
const DEFAULT_GITHUB_MAX_RESPONSE_BYTES = 96 * 1024 * 1024;

const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

/**
 * Small browser-safe GitHub transport used by the reference adapter.
 *
 * REST responses cross the trust boundary only through an explicit decoder, so callers never
 * acquire typed GitHub data through unchecked assertions.
 */
export class GitHubClient {
  readonly owner: string;
  readonly repository: string;

  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly token: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: GitHubAdapterOptions) {
    this.owner = requireSegment(options.owner, 'GitHub owner');
    this.repository = requireSegment(options.repository, 'GitHub repository');
    this.token = options.token;
    this.apiBaseUrl = requireSecureBaseUrl(
      options.apiBaseUrl ?? 'https://api.github.com',
      'GitHub apiBaseUrl',
    );
    this.fetchImpl = options.fetch ?? fetch;
    this.requestTimeoutMs = requirePositiveInteger(
      options.requestTimeoutMs ?? DEFAULT_GITHUB_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    );
    this.maxResponseBytes = requirePositiveInteger(
      options.maxResponseBytes ?? DEFAULT_GITHUB_MAX_RESPONSE_BYTES,
      'maxResponseBytes',
    );
  }

  /** Whether the client can perform GitHub operations that require authentication. */
  get authenticated(): boolean {
    return Boolean(this.token);
  }

  /** Performs a REST request and validates the returned JSON before exposing it to callers. */
  async rest<T>(
    path: string,
    decode: JsonDecoder<T>,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<T> {
    return this.request(`${this.apiBaseUrl}${path}`, init, signal, async (response) =>
      decode(await readJson(response, this.maxResponseBytes, 'GitHub response')),
    );
  }

  /** Performs a REST request whose response body is intentionally ignored. */
  async restVoid(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<void> {
    await this.request(`${this.apiBaseUrl}${path}`, init, signal, async () => undefined);
  }

  /** Executes a GraphQL mutation and validates GitHub's success/error envelope. */
  async graphql(
    query: string,
    variables: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = await this.request(
      `${this.apiBaseUrl}/graphql`,
      {
        method: 'POST',
        body: JSON.stringify({ query, variables }),
      },
      signal,
      (response) => readJson(response, this.maxResponseBytes, 'GitHub GraphQL response'),
    );

    if (!isRecord(body)) {
      throw invalidGraphql('response must be an object.');
    }

    const errors = body.errors;
    if (errors !== undefined) {
      if (!Array.isArray(errors)) {
        throw invalidGraphql('errors must be an array when present.');
      }
      if (errors.length > 0) {
        const messages = errors.map((error) => {
          if (!isRecord(error) || typeof error.message !== 'string') {
            return 'GitHub GraphQL error';
          }
          return error.message;
        });
        throw new RemotishError('INVALID_REQUEST', messages.join('; '));
      }
    }

    if (!isRecord(body.data)) {
      throw invalidGraphql('response did not contain an object-valued data field.');
    }
  }

  private async request<T>(
    url: string,
    init: RequestInit,
    externalSignal: AbortSignal | undefined,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/vnd.github+json');
    headers.set('X-GitHub-Api-Version', '2022-11-28');
    if (this.token) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }
    if (init.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const request = createRequestSignal(externalSignal, this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers,
        signal: request.signal,
      });
    } catch (cause) {
      request.dispose();
      throw normalizeRequestFailure(cause, externalSignal, request.timedOut, this.requestTimeoutMs);
    }

    try {
      if (!response.ok) {
        const message = await responseMessage(response);
        if (response.status === 401) {
          throw new RemotishError('UNAUTHORIZED', message);
        }
        if (response.status === 404) {
          throw new RemotishError('NOT_FOUND', message);
        }
        if (response.status === 422) {
          throw new RemotishError('INVALID_REQUEST', message);
        }
        if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
          throw new RemotishError('RATE_LIMITED', message);
        }
        if (response.status === 403) {
          throw new RemotishError('FORBIDDEN', message);
        }
        throw new RemotishError('UNKNOWN', message);
      }

      return await consume(response);
    } catch (error) {
      if (error instanceof RemotishError) {
        throw error;
      }
      if (externalSignal?.aborted) {
        throw new RemotishError('CANCELLED', 'GitHub request was cancelled.', { cause: error });
      }
      if (request.timedOut()) {
        throw new RemotishError(
          'OFFLINE',
          `GitHub request timed out after ${this.requestTimeoutMs} ms.`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      request.dispose();
    }
  }
}

function requireSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new RemotishError('INVALID_REQUEST', `${label} is required.`);
  }
  return trimmed;
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const body = await readJson(response, MAX_ERROR_RESPONSE_BYTES, 'GitHub error response');
    if (isRecord(body) && typeof body.message === 'string') {
      return `GitHub ${response.status}: ${body.message}`;
    }
  } catch {
    // Fall through to the HTTP status text when GitHub did not return bounded valid JSON.
  }
  return `GitHub ${response.status}: ${response.statusText || 'request failed'}`;
}

async function readJson(response: Response, maxBytes: number, context: string): Promise<unknown> {
  const bytes = await readLimitedBytes(response, maxBytes, context);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (cause) {
    throw new RemotishError('UNKNOWN', `${context} was not valid JSON.`, { cause });
  }
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
    return new RemotishError('CANCELLED', 'GitHub request was cancelled.', { cause: error });
  }
  if (timedOut()) {
    return new RemotishError('OFFLINE', `GitHub request timed out after ${timeoutMs} ms.`, {
      cause: error,
    });
  }
  return new RemotishError('OFFLINE', 'Unable to reach GitHub.', { cause: error });
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

function invalidGraphql(message: string): RemotishError {
  return new RemotishError('UNKNOWN', `Invalid GitHub GraphQL response: ${message}`);
}
