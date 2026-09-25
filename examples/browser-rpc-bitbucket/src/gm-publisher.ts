import { RemotishError } from '@remotish/adapter-sdk';
import type { BitbucketSourcePublisher } from './endpoint.js';

export interface GmXmlHttpResponse {
  readonly status: number;
  readonly responseHeaders: string;
}

export interface GmXmlHttpRequestDetails {
  readonly method: 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly data: FormData;
  readonly anonymous: true;
  readonly redirect: 'manual';
  readonly responseType: 'arraybuffer';
  readonly onload: (response: GmXmlHttpResponse) => void;
  readonly onerror: () => void;
  readonly onabort: () => void;
  readonly ontimeout: () => void;
}

export interface GmXmlHttpRequestHandle {
  abort(): void;
}

export type GmXmlHttpRequest = (details: GmXmlHttpRequestDetails) => GmXmlHttpRequestHandle;

/**
 * Publish through Tampermonkey's background request so the raw Location header is available
 * without depending on Bitbucket's browser CORS exposure.
 */
export function createGmSourcePublisher(gmRequest: GmXmlHttpRequest): BitbucketSourcePublisher {
  return ({ url, authorization, form, signal }) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(cancelled());
        return;
      }
      let settled = false;
      let handle: GmXmlHttpRequestHandle | undefined;
      const finish = (
        value?: { readonly status: number; readonly location?: string },
        error?: RemotishError,
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (error) {
          reject(error);
        } else if (value) {
          resolve(value);
        }
      };
      const onAbort = () => {
        try {
          handle?.abort();
        } finally {
          finish(undefined, cancelled());
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        handle = gmRequest({
          method: 'POST',
          url: url.href,
          headers: { Authorization: authorization, Accept: 'application/json' },
          data: form,
          anonymous: true,
          redirect: 'manual',
          responseType: 'arraybuffer',
          onload: (response) => {
            const location = singleHeader(response.responseHeaders, 'location');
            finish({
              status: response.status,
              ...(location === undefined ? {} : { location }),
            });
          },
          onerror: () => finish(undefined, offline()),
          onabort: () => finish(undefined, cancelled()),
          ontimeout: () => finish(undefined, offline()),
        });
      } catch {
        finish(undefined, offline());
      }
    });
}

function singleHeader(raw: string, name: string): string | undefined {
  const expected = name.toLowerCase();
  const values: string[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    const separator = line.indexOf(':');
    if (separator < 0 || line.slice(0, separator).trim().toLowerCase() !== expected) {
      continue;
    }
    const value = line.slice(separator + 1).trim();
    if (value) {
      values.push(value);
    }
  }
  return values.length === 1 ? values[0] : undefined;
}

function cancelled(): RemotishError {
  return new RemotishError('CANCELLED', 'Bitbucket publication was cancelled.');
}

function offline(): RemotishError {
  return new RemotishError('OFFLINE', 'Bitbucket publication request failed.');
}
