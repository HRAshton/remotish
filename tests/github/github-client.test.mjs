import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubClient } from '../../adapters/github/dist/github-client.js';

function createClient(fetch, options = {}) {
  return new GitHubClient({
    owner: 'acme',
    repository: 'demo',
    fetch,
    ...options,
  });
}

function jsonResponse(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers });
}

test('github client: validates repository coordinates and transport options', () => {
  const fetch = async () => jsonResponse({});
  const invalidRequest = (action) =>
    assert.throws(action, (error) => error?.code === 'INVALID_REQUEST');

  invalidRequest(() => new GitHubClient({ owner: ' ', repository: 'demo', fetch }));
  invalidRequest(() => new GitHubClient({ owner: 'acme', repository: ' ', fetch }));
  invalidRequest(() => createClient(fetch, { apiBaseUrl: 'github.example.invalid/api/v3' }));
  invalidRequest(() =>
    createClient(fetch, { apiBaseUrl: 'https://user:pass@github.example.invalid/api/v3' }),
  );
  invalidRequest(() =>
    createClient(fetch, { apiBaseUrl: 'https://github.example.invalid/api/v3?x=1' }),
  );
  invalidRequest(() =>
    createClient(fetch, { apiBaseUrl: 'https://github.example.invalid/api/v3#fragment' }),
  );
  invalidRequest(() => createClient(fetch, { apiBaseUrl: 'http://github.example.invalid/api/v3' }));

  assert.doesNotThrow(() => createClient(fetch, { apiBaseUrl: 'http://localhost:3000/api/v3/' }));
  assert.doesNotThrow(() => createClient(fetch, { apiBaseUrl: 'http://127.0.0.1:3000/api/v3/' }));
  assert.doesNotThrow(() => createClient(fetch, { apiBaseUrl: 'http://[::1]:3000/api/v3/' }));
  invalidRequest(() => createClient(fetch, { apiBaseUrl: 'http://127.0.0.999/api/v3' }));

  assert.throws(() => createClient(fetch, { requestTimeoutMs: 0 }), RangeError);
  assert.throws(
    () => createClient(fetch, { maxResponseBytes: Number.MAX_SAFE_INTEGER + 1 }),
    RangeError,
  );
});

test('github client: applies required headers and authentication', async () => {
  const calls = [];
  const client = createClient(
    async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true });
    },
    { token: 'secret' },
  );

  assert.equal(client.authenticated, true);
  assert.deepEqual(
    await client.rest('/repos/acme/demo', (value) => value, {
      method: 'POST',
      body: '{}',
    }),
    { ok: true },
  );

  const [{ init }] = calls;
  assert.equal(init.headers.get('accept'), 'application/vnd.github+json');
  assert.equal(init.headers.get('x-github-api-version'), '2022-11-28');
  assert.equal(init.headers.get('authorization'), 'Bearer secret');
  assert.equal(init.headers.get('content-type'), 'application/json');
});

test('github client: maps GitHub HTTP errors to stable Remotish errors', async () => {
  const cases = [
    { status: 401, code: 'UNAUTHORIZED' },
    { status: 404, code: 'NOT_FOUND' },
    { status: 422, code: 'INVALID_REQUEST' },
    { status: 403, code: 'RATE_LIMITED', headers: { 'x-ratelimit-remaining': '0' } },
    { status: 403, code: 'FORBIDDEN' },
    { status: 500, code: 'UNKNOWN' },
  ];

  for (const { status, code, headers } of cases) {
    const client = createClient(async () => jsonResponse({ message: 'boom' }, status, headers));
    await assert.rejects(
      client.rest('/x', (value) => value),
      (error) => error?.code === code && String(error.message).includes(`GitHub ${status}: boom`),
    );
  }
});

test('github client: falls back to HTTP status text for malformed error bodies', async () => {
  const client = createClient(
    async () => new Response('not-json', { status: 502, statusText: 'Bad Gateway' }),
  );
  await assert.rejects(
    client.rest('/x', (value) => value),
    (error) => error?.code === 'UNKNOWN' && error.message === 'GitHub 502: Bad Gateway',
  );
});

test('github client: validates GraphQL success and error envelopes', async () => {
  const responses = [
    { body: [], code: 'UNKNOWN', message: 'response must be an object' },
    { body: { errors: {} }, code: 'UNKNOWN', message: 'errors must be an array' },
    {
      body: { errors: [{ message: 'first' }, {}], data: {} },
      code: 'INVALID_REQUEST',
      message: 'first; GitHub GraphQL error',
    },
    { body: { errors: [] }, code: 'UNKNOWN', message: 'object-valued data field' },
  ];

  for (const { body, code, message } of responses) {
    const client = createClient(async () => jsonResponse(body));
    await assert.rejects(
      client.graphql('mutation Test { test }', {}),
      (error) => error?.code === code && String(error.message).includes(message),
    );
  }

  const success = createClient(async () => jsonResponse({ data: { updateRefs: {} } }));
  await assert.doesNotReject(success.graphql('mutation Test { test }', {}));
});

test('github client: normalizes network, cancellation, and timeout failures', async () => {
  const offline = createClient(async () => {
    throw new Error('network down');
  });
  await assert.rejects(
    offline.rest('/x', (value) => value),
    (error) => error?.code === 'OFFLINE' && error.message === 'Unable to reach GitHub.',
  );

  const controller = new AbortController();
  controller.abort();
  const cancelled = createClient(async () => {
    throw new Error('aborted');
  });
  await assert.rejects(
    cancelled.rest('/x', (value) => value, {}, controller.signal),
    (error) => error?.code === 'CANCELLED',
  );

  const timedOut = createClient(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true });
      }),
    { requestTimeoutMs: 5 },
  );
  await assert.rejects(
    timedOut.rest('/x', (value) => value),
    (error) => error?.code === 'OFFLINE' && String(error.message).includes('timed out after 5 ms'),
  );
});
