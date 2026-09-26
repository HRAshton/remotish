import type { GitHttpRequest, GitHttpResponse } from '@remotish/adapter-git-http';
import { RemotishError } from '@remotish/adapter-sdk';

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** Browser fetch is also used by desktop's extension host; redirects are forbidden for credentials. */
export async function desktopGitRequest(
  configuredUrl: string,
  token: string,
  request: GitHttpRequest,
): Promise<GitHttpResponse> {
  requireConfiguredTarget(configuredUrl, request);
  if (!token || /[\r\n]/u.test(token)) {
    throw new RemotishError('UNAUTHORIZED', 'Configure a Git HTTP bearer token.');
  }
  const body = new ArrayBuffer(request.body.byteLength);
  new Uint8Array(body).set(request.body);
  const response = await fetchWithoutRedirect(request, token, body);
  if (response.url !== request.url) {
    throw new RemotishError('OFFLINE', 'Git HTTP response redirected.');
  }
  const reportedLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(reportedLength) && reportedLength > MAX_RESPONSE_BYTES) {
    throw responseTooLarge();
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return {
    status: response.status,
    headers,
    body: await readLimitedBody(response),
  };
}

function requireConfiguredTarget(configuredUrl: string, request: GitHttpRequest): void {
  const configured = new URL(configuredUrl);
  const target = new URL(request.url);
  if (
    target.origin !== configured.origin ||
    !target.pathname.startsWith(`${configured.pathname}/`) ||
    !['GET', 'POST'].includes(request.method)
  ) {
    throw new RemotishError('INVALID_REQUEST', 'Git HTTP request left the configured origin.');
  }
}

async function fetchWithoutRedirect(
  request: GitHttpRequest,
  token: string,
  body: ArrayBuffer,
): Promise<Response> {
  try {
    return await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers, Authorization: `Bearer ${token}` },
      ...(request.method === 'POST' ? { body } : {}),
      redirect: 'error',
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch {
    if (request.signal?.aborted) {
      throw new RemotishError('CANCELLED', 'Git HTTP request cancelled.');
    }
    throw new RemotishError('OFFLINE', 'Git HTTP request failed or redirected.');
  }
}

async function readLimitedBody(response: Response): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw responseTooLarge();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function responseTooLarge(): RemotishError {
  return new RemotishError('UNSUPPORTED', 'Git HTTP response exceeds the size limit.');
}
