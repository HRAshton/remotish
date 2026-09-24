import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeRpcRequest,
  encodeRpcFailure,
  encodeRpcSuccess,
  RpcAdapter,
} from '@remotish/adapter-rpc';
import { RemotishError } from '@remotish/adapter-sdk';
import { createBitbucketEndpoint } from '../../examples/browser-rpc-bitbucket/build/endpoint.js';
import { BrowserRpcEndpointBroker } from '../../extensions/browser-rpc-provider/build/broker.js';

const revision = 'a'.repeat(40);
const parent = 'b'.repeat(40);
const second = 'c'.repeat(40);
const api = 'https://api.bitbucket.org/2.0/repositories/acme/widgets';
const binary = new Uint8Array([0, 1, 2, 127, 128, 255]);

function fixture(routes = {}) {
  const calls = [];
  const responses = {
    [`${api}`]: {
      uuid: '{585074de-7b60-4fd1-81ed-e0bc7fafbda5}',
      name: 'Widgets',
      mainbranch: { name: 'main' },
      description: 'A repository',
    },
    [`${api}/refs/branches?pagelen=100`]: {
      values: [{ name: 'main', target: { hash: revision } }],
      next: `${api}/refs/branches?pagelen=100&page=2`,
    },
    [`${api}/refs/branches?pagelen=100&page=2`]: {
      values: [{ name: 'feature/test', target: { hash: second } }],
    },
    [`${api}/src/${revision}/?pagelen=100`]: {
      values: [
        { type: 'commit_file', path: 'README.md', size: 12 },
        { type: 'commit_directory', path: 'assets' },
      ],
    },
    [`${api}/src/${revision}/assets?pagelen=100`]: {
      values: [{ type: 'commit_file', path: 'assets/sample.bin', size: binary.length }],
    },
    [`${api}/src/${revision}/assets/sample.bin?format=meta`]: {
      type: 'commit_file',
      path: 'assets/sample.bin',
    },
    [`${api}/src/${revision}/assets/sample.bin`]: binary,
    [`${api}/commits/feature%2Ftest?pagelen=1`]: {
      values: [commit(second, [revision])],
      next: `${api}/commits/feature%2Ftest?pagelen=1&page=2`,
    },
    [`${api}/commits/feature%2Ftest?pagelen=1&page=2`]: {
      values: [{ ...commit(revision, [parent]), message: '' }],
    },
    [`${api}/diffstat/${second}?pagelen=100`]: {
      values: [
        { status: 'added', old: null, new: { path: 'new.txt' } },
        { status: 'modified', old: { path: 'README.md' }, new: { path: 'README.md' } },
        { status: 'removed', old: { path: 'old.txt' }, new: null },
        { status: 'renamed', old: { path: 'before.txt' }, new: { path: 'after.txt' } },
      ],
    },
    ...routes,
  };
  const fetcher = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const value = responses[url];
    if (value === undefined) {
      return new Response('', { status: 404 });
    }
    if (value instanceof Response) {
      return value;
    }
    if (value instanceof Uint8Array) {
      return new Response(value);
    }
    return Response.json(value);
  };
  const endpoint = createBitbucketEndpoint(
    'https://bitbucket.org/acme/widgets/src/main/README.md',
    () => 'read-only-test-token',
    fetcher,
  );
  assert.ok(endpoint);
  const adapter = new RpcAdapter(
    {
      async request(value, options) {
        const request = decodeRpcRequest(value);
        try {
          return encodeRpcSuccess(
            request.operation,
            await endpoint.handle(request, options?.signal ?? new AbortController().signal),
          );
        } catch (error) {
          if (error instanceof RemotishError) {
            return encodeRpcFailure(error.code);
          }
          throw error;
        }
      },
    },
    endpoint.session,
  );
  return { endpoint, adapter, calls };
}

function commit(hash, parents) {
  return {
    hash,
    parents: parents.map((item) => ({ hash: item })),
    message: 'A commit',
    author: { raw: 'Example Author <author@example.test>' },
    date: '2026-09-24T12:00:00+00:00',
  };
}

function errorCode(code) {
  return (error) => error instanceof RemotishError && error.code === code;
}

test('Bitbucket endpoint derives exact target from repository tab only', () => {
  const token = () => 'test';
  const fetcher = async () => new Response('', { status: 404 });
  for (const url of [
    'https://evil.example/acme/widgets',
    'https://bitbucket.org/account/settings',
    'https://bitbucket.org/acme',
    'https://bitbucket.org/acme/widgets@evil.example',
  ]) {
    assert.equal(createBitbucketEndpoint(url, token, fetcher), undefined, url);
  }
  const first = createBitbucketEndpoint('https://bitbucket.org/acme/widgets', token, fetcher);
  const secondTab = createBitbucketEndpoint(
    'https://bitbucket.org/acme/other/src/main',
    token,
    fetcher,
  );
  assert.equal(first?.target, 'https://bitbucket.org/acme/widgets');
  assert.equal(secondTab?.target, 'https://bitbucket.org/acme/other');
  assert.notEqual(first?.target, secondTab?.target);
  assert.deepEqual(first?.session, { version: 1, capabilities: { commits: false } });
});

test('two Bitbucket repository tabs route only to their exact target', async () => {
  const broker = new BrowserRpcEndpointBroker();
  const endpoints = [
    createBitbucketEndpoint('https://bitbucket.org/acme/widgets', () => 'test'),
    createBitbucketEndpoint('https://bitbucket.org/acme/other/src/main', () => 'test'),
  ];
  for (const endpoint of endpoints) {
    assert.ok(endpoint);
    broker.register(
      { origin: 'https://bitbucket.org' },
      {
        target: endpoint.target,
        session: endpoint.session,
        transport: {
          async request(request) {
            return encodeRpcSuccess(request.operation, {
              id: endpoint.target,
              name: 'Repository',
              defaultBranch: 'main',
            });
          },
        },
      },
    );
  }
  for (const endpoint of endpoints) {
    assert.ok(endpoint);
    const selected = broker.find(endpoint.target);
    assert.ok(selected);
    const adapter = new RpcAdapter(selected.transport, selected.session);
    assert.equal((await adapter.getRepository()).id, endpoint.target);
  }
  assert.equal(broker.find('https://bitbucket.org/acme/third'), undefined);
  broker.dispose();
});

test('Bitbucket read contract preserves identity, binary bytes, branches and history', async () => {
  const { adapter, calls } = fixture();
  assert.deepEqual(await adapter.getRepository(), {
    id: 'bitbucket-cloud:{585074de-7b60-4fd1-81ed-e0bc7fafbda5}',
    name: 'Widgets',
    defaultBranch: 'main',
    description: 'A repository',
  });
  assert.deepEqual(await adapter.getBranches(), [
    { name: 'main', revision, isDefault: true },
    { name: 'feature/test', revision: second, isDefault: false },
  ]);
  assert.deepEqual(await adapter.readDirectory(revision, ''), [
    { name: 'README.md', path: 'README.md', type: 'file', size: 12 },
    { name: 'assets', path: 'assets', type: 'directory' },
  ]);
  assert.deepEqual(await adapter.readDirectory(revision, 'assets'), [
    { name: 'sample.bin', path: 'assets/sample.bin', type: 'file', size: 6 },
  ]);
  assert.deepEqual(await adapter.readFile(revision, 'assets/sample.bin'), binary);
  const firstPage = await adapter.getCommits({ branch: 'feature/test', limit: 1 });
  assert.deepEqual(
    firstPage.commits.map((item) => item.revision),
    [second],
  );
  assert.ok(firstPage.nextCursor);
  const nextPage = await adapter.getCommits({
    branch: 'feature/test',
    limit: 1,
    cursor: firstPage.nextCursor,
  });
  assert.deepEqual(
    nextPage.commits.map((item) => item.revision),
    [revision],
  );
  assert.equal(nextPage.commits[0].message, '');
  assert.deepEqual(await adapter.getCommitChanges(second), [
    { type: 'added', path: 'new.txt' },
    { type: 'modified', path: 'README.md' },
    { type: 'deleted', path: 'old.txt' },
    { type: 'renamed', path: 'after.txt', previousPath: 'before.txt' },
  ]);
  assert.equal(adapter.capabilities.commits, false);
  assert.equal(adapter.commit, undefined);
  assert.equal(adapter.createBranch, undefined);
  assert.equal(adapter.deleteBranch, undefined);
  assert.ok(
    calls.every(
      ({ url, init }) =>
        url.startsWith(api) &&
        init.credentials === 'omit' &&
        init.redirect === 'error' &&
        init.headers.Authorization === 'Bearer read-only-test-token',
    ),
  );
});

test('Bitbucket endpoint fails closed on missing token and API errors', async () => {
  const fetcher = async () => new Response('', { status: 401 });
  const missing = createBitbucketEndpoint(
    'https://bitbucket.org/acme/widgets',
    () => undefined,
    fetcher,
  );
  assert.ok(missing);
  await assert.rejects(
    missing.handle(
      { version: 1, operation: 'getRepository', payload: {} },
      new AbortController().signal,
    ),
    errorCode('UNAUTHORIZED'),
  );
  for (const [status, code] of [
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [503, 'OFFLINE'],
  ]) {
    const endpoint = createBitbucketEndpoint(
      'https://bitbucket.org/acme/widgets',
      () => 'token',
      async () => new Response('', { status }),
    );
    assert.ok(endpoint);
    await assert.rejects(
      endpoint.handle(
        { version: 1, operation: 'getRepository', payload: {} },
        new AbortController().signal,
      ),
      errorCode(code),
    );
  }
});

test('Bitbucket response validation rejects malformed pages, paths and pagination targets', async () => {
  const invalidPage = fixture({ [`${api}/refs/branches?pagelen=100`]: { values: 'not an array' } });
  await assert.rejects(invalidPage.adapter.getBranches(), errorCode('UNKNOWN'));
  const foreignNext = fixture({
    [`${api}/refs/branches?pagelen=100`]: { values: [], next: 'https://evil.example/steal' },
  });
  await assert.rejects(foreignNext.adapter.getBranches(), errorCode('UNKNOWN'));
  const badChild = fixture({
    [`${api}/src/${revision}/?pagelen=100`]: {
      values: [{ type: 'commit_file', path: '../escape' }],
    },
  });
  await assert.rejects(badChild.adapter.readDirectory(revision, ''), errorCode('UNKNOWN'));
  const malformedFile = fixture({
    [`${api}/src/${revision}/assets/sample.bin?format=meta`]: {
      type: 'commit_directory',
      path: 'assets/sample.bin',
    },
  });
  await assert.rejects(
    malformedFile.adapter.readFile(revision, 'assets/sample.bin'),
    errorCode('NOT_FOUND'),
  );
  const badDate = fixture({
    [`${api}/commits/feature%2Ftest?pagelen=1`]: {
      values: [{ ...commit(second, [revision]), date: 'not-a-date' }],
    },
  });
  await assert.rejects(
    badDate.adapter.getCommits({ branch: 'feature/test', limit: 1 }),
    errorCode('UNKNOWN'),
  );
});

test('Bitbucket file and JSON reads reject oversized responses before transport serialization', async () => {
  const tooLarge = fixture({
    [`${api}/src/${revision}/assets/sample.bin`]: new Response(
      new Uint8Array(16 * 1024 * 1024 + 1),
    ),
  });
  await assert.rejects(
    tooLarge.adapter.readFile(revision, 'assets/sample.bin'),
    errorCode('UNSUPPORTED'),
  );
  const largeJson = fixture({
    [`${api}`]: new Response('x', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
  });
  await assert.rejects(largeJson.adapter.getRepository(), errorCode('UNSUPPORTED'));
  const partialFile = fixture({
    [`${api}/src/${revision}/assets/sample.bin`]: new Response(binary, { status: 206 }),
  });
  await assert.rejects(
    partialFile.adapter.readFile(revision, 'assets/sample.bin'),
    errorCode('UNKNOWN'),
  );
});
