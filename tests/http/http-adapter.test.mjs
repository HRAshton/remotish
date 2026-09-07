import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpRemotishAdapter } from '@remotish/adapter-http';
import { RemotishError } from '@remotish/adapter-sdk';

const encoder = new TextEncoder();

function createFetch(handler) {
  return async (input, init = {}) => handler(String(input), init);
}

const capabilities = {
  commits: true,
  forceWithLease: true,
  amend: true,
  createBranch: true,
  deleteBranch: true,
};

test('http adapter: encodes paths and reads binary files without text conversion', async () => {
  const calls = [];
  const adapter = new HttpRemotishAdapter({
    baseUrl: 'https://example.invalid/api/',
    capabilities,
    fetch: createFetch((url, init) => {
      calls.push({ url, init });
      return new Response(new Uint8Array([0, 1, 127, 255]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }),
  });

  const content = await adapter.readFile('r 1', 'dir/a b.bin');
  assert.deepEqual(content, new Uint8Array([0, 1, 127, 255]));
  assert.equal(calls[0].url, 'https://example.invalid/api/file?revision=r+1&path=dir%2Fa+b.bin');
});

test('http adapter: commit wire format is small and base64 encodes changed content', async () => {
  let body;
  const adapter = new HttpRemotishAdapter({
    baseUrl: 'https://example.invalid',
    capabilities,
    fetch: createFetch(async (_url, init) => {
      body = JSON.parse(String(init.body));
      return Response.json({
        status: 'success',
        revision: 'C4',
        commit: { revision: 'C4', parents: ['C3'], message: 'Publish' },
      });
    }),
  });

  const result = await adapter.commit({
    type: 'commit',
    branch: 'main',
    baseRevision: 'C3',
    message: 'Publish',
    changes: [{ type: 'modify', path: 'README.md', content: encoder.encode('hello') }],
    push: { mode: 'normal' },
  });
  assert.equal(result.status, 'success');
  assert.equal(body.changes[0].contentBase64, 'aGVsbG8=');
  assert.equal('content' in body.changes[0], false);
});

test('http adapter: 409 commit rejection is returned as domain state, not thrown', async () => {
  const adapter = new HttpRemotishAdapter({
    baseUrl: 'https://example.invalid',
    capabilities,
    fetch: createFetch(() =>
      Response.json(
        {
          status: 'rejected',
          reason: 'REMOTE_CHANGED',
          remoteRevision: 'C9',
        },
        { status: 409 },
      ),
    ),
  });

  const result = await adapter.commit({
    type: 'commit',
    branch: 'main',
    baseRevision: 'C3',
    message: 'Publish',
    changes: [{ type: 'delete', path: 'old.ts' }],
    push: { mode: 'normal' },
  });
  assert.deepEqual(result, { status: 'rejected', reason: 'REMOTE_CHANGED', remoteRevision: 'C9' });
});

test('http adapter: HTTP and network failures become structured Remotish errors', async () => {
  const forbidden = new HttpRemotishAdapter({
    baseUrl: 'https://example.invalid',
    capabilities,
    fetch: createFetch(() => Response.json({ message: 'No access' }, { status: 403 })),
  });
  await assert.rejects(
    forbidden.getRepository(),
    (error) =>
      error instanceof RemotishError && error.code === 'FORBIDDEN' && error.message === 'No access',
  );

  const offline = new HttpRemotishAdapter({
    baseUrl: 'https://example.invalid',
    capabilities,
    fetch: createFetch(() => {
      throw new TypeError('network');
    }),
  });
  await assert.rejects(
    offline.getRepository(),
    (error) => error instanceof RemotishError && error.code === 'OFFLINE',
  );
});

test('http adapter: rejects malformed protocol JSON before it enters the SDK model', async () => {
  const adapter = new HttpRemotishAdapter({
    baseUrl: 'https://example.invalid',
    capabilities,
    fetch: createFetch(() => Response.json({ id: 'demo', name: 'Demo', defaultBranch: 42 })),
  });

  await assert.rejects(
    adapter.getRepository(),
    (error) =>
      error instanceof RemotishError &&
      error.code === 'UNKNOWN' &&
      error.message.includes('Invalid HTTP adapter response: repository.defaultBranch'),
  );
});

test('http adapter: rejects plaintext remote base URLs but permits loopback development HTTP', () => {
  assert.throws(
    () =>
      new HttpRemotishAdapter({
        baseUrl: 'http://example.invalid/api',
        capabilities,
        headers: { Authorization: 'Bearer secret' },
      }),
    (error) => error instanceof RemotishError && error.code === 'INVALID_REQUEST',
  );

  assert.doesNotThrow(
    () =>
      new HttpRemotishAdapter({
        baseUrl: 'http://127.0.0.1:3000/api',
        capabilities,
        fetch: createFetch(() => Response.json({})),
      }),
  );
});

test('http adapter: enforces file response byte limits before retaining oversized bodies', async () => {
  const adapter = new HttpRemotishAdapter({
    baseUrl: 'https://example.invalid',
    capabilities,
    maxFileBytes: 3,
    fetch: createFetch(
      () =>
        new Response(new Uint8Array([0, 1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
    ),
  });

  await assert.rejects(
    adapter.readFile('C1', 'large.bin'),
    (error) => error instanceof RemotishError && error.code === 'UNSUPPORTED',
  );
});

test('http adapter: aborts requests that exceed the configured deadline', async () => {
  const adapter = new HttpRemotishAdapter({
    baseUrl: 'https://example.invalid',
    capabilities,
    requestTimeoutMs: 5,
    fetch: createFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    ),
  });

  await assert.rejects(
    adapter.getRepository(),
    (error) =>
      error instanceof RemotishError &&
      error.code === 'OFFLINE' &&
      /timed out/u.test(error.message),
  );
});
