import { RemotishError } from '@remotish/adapter-sdk';
import { malformed, page, parseJson } from './codec.js';
import type { RepositoryRoute } from './route.js';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 100;
const MAX_LIST_ITEMS = 10_000;

export type BitbucketDataCenterTokenSource = () => string | undefined | Promise<string | undefined>;

/** Bounded authenticated REST transport scoped to one Data Center server base. */
export class BitbucketDataCenterApiClient {
  constructor(
    private readonly route: RepositoryRoute,
    private readonly token: BitbucketDataCenterTokenSource,
    private readonly fetcher: typeof fetch,
  ) {}

  async getAll(
    path: string,
    initial: URLSearchParams,
    signal: AbortSignal,
  ): Promise<readonly unknown[]> {
    const values: unknown[] = [];
    const seen = new Set<number>();
    let start = 0;
    for (let count = 0; count < MAX_PAGES; count += 1) {
      if (seen.has(start)) {
        throw malformed('pagination loop');
      }
      seen.add(start);
      const params = new URLSearchParams(initial);
      params.set('limit', '100');
      params.set('start', String(start));
      const result = page(await this.getJson(this.url(path, params), signal));
      values.push(...result.values);
      if (values.length > MAX_LIST_ITEMS) {
        throw new RemotishError('UNSUPPORTED', 'Bitbucket listing exceeds the supported limit.');
      }
      if (result.nextPageStart === undefined) {
        return values;
      }
      start = result.nextPageStart;
    }
    throw new RemotishError('UNSUPPORTED', 'Bitbucket listing exceeds the page limit.');
  }

  url(path: string, params?: URLSearchParams): string {
    const url = new URL(path, this.route.serverBase);
    if (params !== undefined) {
      url.search = params.toString();
    }
    return url.href;
  }

  async getJson(pathOrUrl: string, signal: AbortSignal): Promise<unknown> {
    return parseJson(
      await this.getBytes(pathOrUrl, undefined, MAX_JSON_BYTES, signal, 'application/json'),
    );
  }

  async responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
    return parseJson(await this.responseBytes(response, MAX_JSON_BYTES, signal));
  }

  async request(
    pathOrUrl: string,
    method: 'GET' | 'POST' | 'DELETE',
    signal: AbortSignal,
    body?: string,
    contentType?: string,
    accept = 'application/json',
  ): Promise<Response> {
    const credential = await this.credential();
    const url = new URL(pathOrUrl, this.route.serverBase);
    if (!url.href.startsWith(this.route.serverBase)) {
      throw new RemotishError(
        'INVALID_REQUEST',
        'Bitbucket request escaped the configured server.',
      );
    }
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: {
          Authorization: `Bearer ${credential}`,
          Accept: accept,
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
        'Bitbucket Data Center API request failed.',
      );
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new RemotishError(
        'UNSUPPORTED',
        'Bitbucket Data Center API redirect is not supported.',
      );
    }
    return response;
  }

  async getBytes(
    pathOrUrl: string,
    params: URLSearchParams | undefined,
    limit: number,
    signal: AbortSignal,
    accept: string,
  ): Promise<Uint8Array> {
    const target = params === undefined ? pathOrUrl : this.url(pathOrUrl, params);
    const response = await this.request(target, 'GET', signal, undefined, undefined, accept);
    this.requireStatus(response, 200);
    return this.responseBytes(response, limit, signal);
  }

  requireStatus(response: Response, expected: number): void {
    if (response.status === expected) {
      return;
    }
    const code =
      response.status === 400 || response.status === 409
        ? 'INVALID_REQUEST'
        : response.status === 401
          ? 'UNAUTHORIZED'
          : response.status === 403
            ? 'FORBIDDEN'
            : response.status === 404
              ? 'NOT_FOUND'
              : response.status === 429
                ? 'RATE_LIMITED'
                : response.status >= 500
                  ? 'OFFLINE'
                  : 'UNKNOWN';
    throw new RemotishError(code, `Bitbucket Data Center API request failed (${code}).`);
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

  private async credential(): Promise<string> {
    let credential: string | undefined;
    try {
      credential = await this.token();
    } catch {
      throw new RemotishError('UNAUTHORIZED', 'Bitbucket Data Center token is unavailable.');
    }
    if (
      typeof credential !== 'string' ||
      !credential ||
      credential.length > 4096 ||
      [...credential].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    ) {
      throw new RemotishError('UNAUTHORIZED', 'Configure a Bitbucket Data Center access token.');
    }
    return credential;
  }
}

function responseTooLarge(): RemotishError {
  return new RemotishError('UNSUPPORTED', 'Bitbucket response exceeds the supported size.');
}
