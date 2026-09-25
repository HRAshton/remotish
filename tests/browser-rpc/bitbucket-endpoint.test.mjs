import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeRpcRequest,
  encodeRpcFailure,
  encodeRpcSuccess,
  RpcAdapter,
} from '@remotish/adapter-rpc';
import { RemotishError } from '@remotish/adapter-sdk';
import { MemoryWorkspaceStorage, RemotishWorkspace } from '@remotish/core';
import { createBitbucketEndpoint } from '../../examples/browser-rpc-bitbucket/build/endpoint.js';
import { createGmSourcePublisher } from '../../examples/browser-rpc-bitbucket/build/gm-publisher.js';
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
      attributes: [],
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
  const responseFor = async (url, init) => {
    let value = responses[url];
    if (typeof value === 'function') {
      value = await value(init);
    }
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
  const fetcher = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return responseFor(url, init);
  };
  const sourcePublisher = async ({ url, authorization, form, signal }) => {
    const init = {
      method: 'POST',
      headers: { Authorization: authorization, Accept: 'application/json' },
      body: form,
      credentials: 'omit',
      redirect: 'manual',
      signal,
    };
    calls.push({ url: url.href, init });
    const response = await responseFor(url.href, init);
    const location = response.headers.get('location');
    return { status: response.status, ...(location === null ? {} : { location }) };
  };
  const endpoint = createBitbucketEndpoint(
    'https://bitbucket.org/acme/widgets/src/main/README.md',
    () => 'read-only-test-token',
    fetcher,
    sourcePublisher,
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

test('GM source publisher exposes the raw Location header without page cookies', async () => {
  let details;
  const publisher = createGmSourcePublisher((value) => {
    details = value;
    queueMicrotask(() =>
      value.onload({
        status: 201,
        responseHeaders: `Location: ${api}/commit/${second}\r\nContent-Length: 0\r\n`,
      }),
    );
    return { abort() {} };
  });
  const form = new FormData();
  form.set('branch', 'main');
  const result = await publisher({
    url: new URL(`${api}/src`),
    authorization: 'Bearer test-token',
    form,
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, { status: 201, location: `${api}/commit/${second}` });
  assert.equal(details.url, `${api}/src`);
  assert.equal(details.method, 'POST');
  assert.equal(details.headers.Authorization, 'Bearer test-token');
  assert.equal(details.data, form);
  assert.equal(details.anonymous, true);
  assert.equal(details.redirect, 'manual');
  assert.equal(details.responseType, 'arraybuffer');
});

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
  assert.deepEqual(first?.session, {
    version: 1,
    capabilities: { commits: false, createBranch: true, deleteBranch: true },
  });
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
  assert.equal(adapter.capabilities.commits, true);
  assert.equal(typeof adapter.commit, 'function');
  assert.equal(typeof adapter.createBranch, 'function');
  assert.equal(typeof adapter.deleteBranch, 'function');
  assert.equal(adapter.capabilities.forceWithLease, undefined);
  assert.equal(adapter.capabilities.amend, undefined);
  assert.ok(
    calls.every(
      ({ url, init }) =>
        url.startsWith(api) &&
        init.credentials === 'omit' &&
        init.redirect === 'manual' &&
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

test('Bitbucket file redirects are unsupported without following or leaking the token', async () => {
  const source = `${api}/src/${revision}/assets/sample.bin`;
  const redirected = fixture({
    [source]: new Response(null, {
      status: 301,
      headers: { location: 'https://media.example/file' },
    }),
  });
  await assert.rejects(
    redirected.adapter.readFile(revision, 'assets/sample.bin'),
    errorCode('UNSUPPORTED'),
  );
  assert.equal(redirected.calls.filter(({ url }) => url === source).length, 1);
  assert.ok(redirected.calls.every(({ url }) => url.startsWith(api)));

  const endpoint = createBitbucketEndpoint(
    'https://bitbucket.org/acme/widgets',
    () => 'token',
    async () => {
      throw new TypeError('network failure');
    },
  );
  assert.ok(endpoint);
  await assert.rejects(
    endpoint.handle(
      { version: 1, operation: 'getRepository', payload: {} },
      new AbortController().signal,
    ),
    errorCode('OFFLINE'),
  );
});

test('Bitbucket normal commit publishes binary additions, modifications and deletions atomically', async () => {
  const { adapter, calls } = fixture({
    [`${api}/src/${revision}/assets/old.bin?format=meta`]: {
      type: 'commit_file',
      path: 'assets/old.bin',
      attributes: ['binary'],
    },
    [`${api}/src`]: new Response(null, {
      status: 201,
      headers: { location: `${api}/commit/${second}` },
    }),
  });
  const result = await adapter.commit({
    type: 'commit',
    branch: 'feature/test',
    baseRevision: revision,
    message: 'Publish bytes',
    changes: [
      { type: 'add', path: 'new.bin', content: binary },
      { type: 'modify', path: 'assets/old.bin', content: new Uint8Array([255, 0]) },
      { type: 'delete', path: 'removed.txt' },
    ],
    push: { mode: 'normal' },
  });
  assert.deepEqual(result, {
    status: 'success',
    revision: second,
    commit: {
      revision: second,
      parents: [revision],
      message: 'Publish bytes',
    },
  });
  assert.equal(calls[0].url, `${api}/src/${revision}/assets/old.bin?format=meta`);
  assert.equal(calls[0].init.method, 'GET');
  const publication = calls.find(({ url, init }) => url === `${api}/src` && init.method === 'POST');
  assert.ok(publication);
  const { url, init } = publication;
  assert.equal(url, `${api}/src`);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.headers.Authorization, 'Bearer read-only-test-token');
  assert.equal(init.headers['Content-Type'], undefined);
  assert.equal(init.body.get('branch'), 'feature/test');
  assert.equal(init.body.get('parents'), revision);
  assert.equal(init.body.get('message'), 'Publish bytes');
  assert.deepEqual(init.body.getAll('files'), ['removed.txt']);
  assert.deepEqual(new Uint8Array(await init.body.get('new.bin').arrayBuffer()), binary);
  assert.deepEqual(
    new Uint8Array(await init.body.get('assets/old.bin').arrayBuffer()),
    new Uint8Array([255, 0]),
  );
});

test('Bitbucket rejects attributed modifications before publication', async () => {
  const request = {
    type: 'commit',
    branch: 'main',
    baseRevision: revision,
    message: 'Update tool',
    changes: [{ type: 'modify', path: 'bin/tool', content: new Uint8Array([65]) }],
    push: { mode: 'normal' },
  };
  for (const attribute of ['link', 'executable', 'subrepository', 'future-mode']) {
    const { adapter, calls } = fixture({
      [`${api}/src/${revision}/bin/tool?format=meta`]: {
        type: 'commit_file',
        path: 'bin/tool',
        attributes: [attribute],
      },
    });
    assert.deepEqual(await adapter.commit(request), {
      status: 'rejected',
      reason: 'UNSUPPORTED',
      message: 'Bitbucket cannot safely modify a file with repository attributes.',
    });
    assert.equal(
      calls.some(({ url, init }) => url === `${api}/src` && init.method === 'POST'),
      false,
      attribute,
    );
  }

  const malformed = fixture({
    [`${api}/src/${revision}/bin/tool?format=meta`]: {
      type: 'commit_file',
      path: 'bin/tool',
      attributes: 'executable',
    },
  });
  assert.deepEqual(await malformed.adapter.commit(request), {
    status: 'rejected',
    reason: 'UNSUPPORTED',
    message:
      'Bitbucket commit preflight failed before publication (UNKNOWN). No write was attempted.',
  });
  assert.equal(
    malformed.calls.some(({ url, init }) => url === `${api}/src` && init.method === 'POST'),
    false,
  );

  const binaryOnly = fixture({
    [`${api}/src/${revision}/bin/tool?format=meta`]: {
      type: 'commit_file',
      path: 'bin/tool',
      attributes: ['binary'],
    },
    [`${api}/src`]: new Response(null, {
      status: 201,
      headers: { location: `${api}/commit/${second}` },
    }),
  });
  assert.equal((await binaryOnly.adapter.commit(request)).status, 'success');
});

test('Bitbucket pre-dispatch probe failure settles the workspace publication journal', async () => {
  const failingRoutes = new Set();
  const metadataUrl = `${api}/src/${revision}/assets/sample.bin?format=meta`;
  const { adapter, calls } = fixture({
    [metadataUrl]: () => {
      if (failingRoutes.has(metadataUrl)) {
        throw new TypeError('preflight network failure');
      }
      return {
        type: 'commit_file',
        path: 'assets/sample.bin',
        attributes: [],
      };
    },
  });
  const storage = new MemoryWorkspaceStorage();
  const workspace = await RemotishWorkspace.open(adapter, storage);
  await workspace.writeFile('assets/sample.bin', new Uint8Array([9, 8, 7]), {
    create: false,
    overwrite: true,
  });

  failingRoutes.add(metadataUrl);
  const result = await workspace.commitAndPush('Probe fails before publish');
  assert.deepEqual(result, {
    status: 'rejected',
    reason: 'UNSUPPORTED',
    message:
      'Bitbucket commit preflight failed before publication (OFFLINE). No write was attempted.',
  });
  assert.equal(workspace.pendingPublication, undefined);
  assert.equal(workspace.hasChanges, true);
  assert.equal(
    calls.some(({ url, init }) => url === `${api}/src` && init.method === 'POST'),
    false,
  );

  failingRoutes.delete(metadataUrl);
  await workspace.writeFile('assets/sample.bin', new Uint8Array([6, 5, 4]), {
    create: false,
    overwrite: true,
  });
});

test('Bitbucket multipart commits allow root filenames that match metadata fields', async () => {
  const { adapter, calls } = fixture({
    [`${api}/src`]: new Response(null, {
      status: 201,
      headers: { location: `${api}/commit/${second}` },
    }),
  });
  const names = ['message', 'branch', 'parents', 'files'];
  const result = await adapter.commit({
    type: 'commit',
    branch: 'main',
    baseRevision: revision,
    message: 'Publish metadata-named files',
    changes: names.map((path, index) => ({
      type: 'add',
      path,
      content: new Uint8Array([index + 1]),
    })),
    push: { mode: 'normal' },
  });
  assert.equal(result.status, 'success');
  const publication = calls.find(({ url, init }) => url === `${api}/src` && init.method === 'POST');
  assert.ok(publication);
  for (const [index, name] of names.entries()) {
    const fileParts = publication.init.body.getAll(name).filter((value) => value instanceof Blob);
    assert.equal(fileParts.length, 1, name);
    assert.equal(fileParts[0].name, name);
    assert.deepEqual(new Uint8Array(await fileParts[0].arrayBuffer()), new Uint8Array([index + 1]));
  }
});

test('Bitbucket stale-head conflict is settled, but dispatched failures remain ambiguous', async () => {
  const request = {
    type: 'commit',
    branch: 'main',
    baseRevision: revision,
    message: 'Update',
    changes: [{ type: 'add', path: 'new.txt', content: new Uint8Array([65]) }],
    push: { mode: 'normal' },
  };
  const conflict = fixture({ [`${api}/src`]: new Response('', { status: 409 }) });
  assert.deepEqual(await conflict.adapter.commit(request), {
    status: 'rejected',
    reason: 'REMOTE_CHANGED',
  });
  assert.equal(conflict.calls.length, 1);

  let dispatches = 0;
  const endpoint = createBitbucketEndpoint(
    'https://bitbucket.org/acme/widgets',
    () => 'token',
    async () => new Response('', { status: 404 }),
    async () => {
      dispatches += 1;
      throw new RemotishError('OFFLINE', 'connection failed after dispatch');
    },
  );
  assert.ok(endpoint);
  await assert.rejects(
    endpoint.handle(
      { version: 1, operation: 'commit', payload: request },
      new AbortController().signal,
    ),
    errorCode('OFFLINE'),
  );
  assert.equal(dispatches, 1);

  for (const response of [
    new Response(null, { status: 201 }),
    new Response(null, {
      status: 201,
      headers: { location: `https://evil.example/2.0/repositories/acme/widgets/commit/${second}` },
    }),
    new Response(null, {
      status: 201,
      headers: { location: `${api}/commit/${second}?token=secret` },
    }),
    new Response(null, {
      status: 201,
      headers: { location: `${api}/commit/not-a-sha` },
    }),
  ]) {
    const malformed = fixture({ [`${api}/src`]: response });
    await assert.rejects(malformed.adapter.commit(request), errorCode('UNKNOWN'));
  }
});

test('Bitbucket rejects unsupported and oversized commits before dispatch', async () => {
  const { endpoint, calls } = fixture();
  const normal = {
    type: 'commit',
    branch: 'main',
    baseRevision: revision,
    message: 'Update',
    changes: [{ type: 'add', path: 'new.bin', content: binary }],
    push: { mode: 'normal' },
  };
  const signal = new AbortController().signal;
  for (const request of [
    { ...normal, push: { mode: 'force-with-lease', expectedRevision: revision } },
    { ...normal, type: 'amend', push: { mode: 'force-with-lease', expectedRevision: revision } },
    { ...normal, changes: [{ type: 'add', path: 'bad\ud800path', content: binary }] },
    { ...normal, changes: [{ type: 'delete', path: 'bad\npath' }] },
    { ...normal, branch: '../invalid' },
    { ...normal, baseRevision: 'not-a-hash' },
    { ...normal, changes: [normal.changes[0], normal.changes[0]] },
    {
      ...normal,
      changes: [{ type: 'add', path: 'large.bin', content: new Uint8Array(16 * 1024 * 1024 + 1) }],
    },
  ]) {
    assert.equal(
      (await endpoint.handle({ version: 1, operation: 'commit', payload: request }, signal)).reason,
      'UNSUPPORTED',
    );
  }
  assert.equal(calls.length, 0);
});

test('Bitbucket branch creation and deletion use scoped refs endpoints', async () => {
  const { adapter, calls } = fixture({
    [`${api}/refs/branches`]: Response.json(
      { name: 'feature/test', target: { hash: second } },
      { status: 201 },
    ),
    [`${api}/refs/branches/feature%2Ftest`]: new Response(null, { status: 204 }),
  });
  assert.deepEqual(await adapter.createBranch('feature/test', second), {
    name: 'feature/test',
    revision: second,
  });
  await adapter.deleteBranch('feature/test');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    name: 'feature/test',
    target: { hash: second },
  });
  assert.equal(calls[1].url, `${api}/refs/branches/feature%2Ftest`);
  assert.equal(calls[1].init.method, 'DELETE');
  assert.equal(calls[1].init.body, undefined);
});

test('Bitbucket branch writes fail closed on invalid input and responses', async () => {
  const invalid = fixture();
  await assert.rejects(
    invalid.adapter.createBranch('../main', second),
    errorCode('INVALID_REQUEST'),
  );
  await assert.rejects(
    invalid.adapter.createBranch('feature/test', 'not-a-hash'),
    errorCode('INVALID_REQUEST'),
  );
  await assert.rejects(invalid.adapter.deleteBranch('main.lock'), errorCode('INVALID_REQUEST'));
  assert.equal(invalid.calls.length, 0);
  const wrongTarget = fixture({
    [`${api}/refs/branches`]: Response.json(
      { name: 'feature/test', target: { hash: parent } },
      { status: 201 },
    ),
  });
  await assert.rejects(
    wrongTarget.adapter.createBranch('feature/test', second),
    errorCode('UNKNOWN'),
  );
  const forbidden = fixture({
    [`${api}/refs/branches/main`]: new Response('', { status: 403 }),
  });
  await assert.rejects(forbidden.adapter.deleteBranch('main'), errorCode('FORBIDDEN'));
});
