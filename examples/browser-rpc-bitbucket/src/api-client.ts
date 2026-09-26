import { RemotishError } from '@remotish/adapter-sdk';
import { malformed, page, parseJson } from './codec.js';

const API_ORIGIN = 'https://api.bitbucket.org';
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 100;
const MAX_LIST_ITEMS = 10_000;

export type BitbucketTokenSource = () => string | undefined | Promise<string | undefined>;

/** Bounded authenticated Bitbucket Cloud REST transport. */
export class BitbucketApiClient {
  constructor(
    private readonly token: BitbucketTokenSource,
    private readonly fetcher: typeof fetch,
  ) {}

  async getAll(path: string, signal: AbortSignal): Promise<readonly unknown[]> {
    const values: unknown[] = [];
    let next: string | undefined = `${path}?pagelen=100`;
    const seen = new Set<string>();
    for (let count = 0; next !== undefined && count < MAX_PAGES; count += 1) {
      const url = this.nextUrl(next, path);
      if (seen.has(url)) {
        throw malformed('pagination loop');
      }
      seen.add(url);
      const result = page(await this.getJson(url, signal));
      values.push(...result.values);
      if (values.length > MAX_LIST_ITEMS) {
        throw new RemotishError('UNSUPPORTED', 'Bitbucket listing exceeds the supported limit.');
      }
      next = result.next;
    }
    if (next !== undefined) {
      throw new RemotishError('UNSUPPORTED', 'Bitbucket listing exceeds the page limit.');
    }
    return values;
  }

  nextUrl(value: string, path: string): string {
    let url: URL;
    try {
      url = new URL(value, API_ORIGIN);
    } catch {
      throw malformed('pagination URL');
    }
    if (
      url.origin !== API_ORIGIN ||
      url.pathname !== path ||
      url.username ||
      url.password ||
      url.hash ||
      url.href.length > 2048
    ) {
      throw malformed('pagination URL');
    }
    return url.href;
  }

  async getJson(path: string, signal: AbortSignal): Promise<unknown> {
    return parseJson(await this.getBytes(path, MAX_JSON_BYTES, signal));
  }

  async responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
    return parseJson(await this.responseBytes(response, MAX_JSON_BYTES, signal));
  }

  async request(
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    signal: AbortSignal,
    body?: FormData | string,
    contentType?: string,
  ): Promise<Response> {
    const credential = await this.credential();
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, API_ORIGIN), {
        method,
        headers: {
          Authorization: `Bearer ${credential}`,
          Accept: 'application/json',
          ...(contentType ? { 'Content-Type': contentType } : {}),
        },
        ...(body === undefined ? {} : { body }),
        credentials: 'omit',
        redirect: 'manual',
        signal,
      });
    } catch {
      throw new RemotishError(
        signal.aborted ? 'CANCELLED' : 'OFFLINE',
        'Bitbucket API request failed.',
      );
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new RemotishError('UNSUPPORTED', 'Bitbucket API redirect is not supported.');
    }
    return response;
  }

  async getBytes(path: string, limit: number, signal: AbortSignal): Promise<Uint8Array> {
    const response = await this.request(path, 'GET', signal);
    this.requireStatus(response, 200);
    return this.responseBytes(response, limit, signal);
  }

  requireStatus(response: Response, expected: number): void {
    this.requireStatusCode(response.status, expected);
  }

  requireStatusCode(status: number, expected: number): void {
    if (status === expected) {
      return;
    }
    const code =
      status === 401
        ? 'UNAUTHORIZED'
        : status === 403
          ? 'FORBIDDEN'
          : status === 404
            ? 'NOT_FOUND'
            : status === 429
              ? 'RATE_LIMITED'
              : status >= 500
                ? 'OFFLINE'
                : 'UNKNOWN';
    throw new RemotishError(code, `Bitbucket API request failed (${code}).`);
  }

  async responseBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) > limit) {
      throw responseTooLarge();
    }
    const reader = response.body?.getReader();
    if (!reader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > limit) {
        throw responseTooLarge();
      }
      return bytes;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) {
          break;
        }
        size += part.value.length;
        if (size > limit) {
          await reader.cancel();
          throw responseTooLarge();
        }
        chunks.push(part.value);
      }
    } catch (error) {
      if (error instanceof RemotishError) {
        throw error;
      }
      throw new RemotishError(
        signal.aborted ? 'CANCELLED' : 'OFFLINE',
        'Bitbucket response stream failed.',
      );
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  async credential(): Promise<string> {
    let credential: string | undefined;
    try {
      credential = await this.token();
    } catch {
      throw new RemotishError('UNAUTHORIZED', 'Bitbucket token is unavailable.');
    }
    if (
      typeof credential !== 'string' ||
      !credential ||
      credential.length > 2048 ||
      [...credential].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    ) {
      throw new RemotishError('UNAUTHORIZED', 'Configure a Bitbucket repository access token.');
    }
    return credential;
  }
}

function responseTooLarge(): RemotishError {
  return new RemotishError('UNSUPPORTED', 'Bitbucket response exceeds the supported size.');
}
