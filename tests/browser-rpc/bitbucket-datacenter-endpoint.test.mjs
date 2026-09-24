import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeRpcRequest,
  encodeRpcFailure,
  encodeRpcSuccess,
  RpcAdapter,
} from '@remotish/adapter-rpc';
import { RemotishError } from '@remotish/adapter-sdk';
import { createBitbucketDataCenterEndpoint } from '../../examples/browser-rpc-bitbucket-datacenter/build/endpoint.js';

const origin = 'https://bitbucket.example.test';
const server = `${origin}/bitbucket/`;
const target = `${server}projects/PRJ/repos/widgets`;
const api = `${server}rest/api/1.0/projects/PRJ/repos/widgets`;
const branchApi = `${server}rest/branch-utils/1.0/projects/PRJ/repos/widgets/branches`;
const revision = 'a'.repeat(40);
const parent = 'b'.repeat(40);
const second = 'c'.repeat(40);
const binary = new Uint8Array([0, 1, 2, 127, 128, 255]);

function fixture(routes = {}) {
  const calls = [];
  const responses = {
    [api]: {
      id: 42,
      name: 'Widgets',
      slug: 'widgets',
      description: 'A repository',
      scmId: 'git',
      defaultBranch: 'main',
      project: { key: 'PRJ' },
    },
    [`${api}/branches?limit=100&start=0`]: {
      size: 1,
      limit: 1,
      isLastPage: false,
      nextPageStart: 1,
      start: 0,
      values: [branch('main', revision)],
    },
    [`${api}/branches?limit=100&start=1`]: {
      size: 1,
      limit: 1,
      isLastPage: true,
      start: 1,
      values: [branch('feature/test', second)],
    },
    [`${api}/files?at=${revision}&limit=100&start=0`]: {
      size: 3,
      limit: 100,
      isLastPage: true,
      start: 0,
      values: ['README.md', 'assets/nested/icon.svg', 'assets/sample.bin'],
    },
    [`${api}/files/assets?at=${revision}&limit=100&start=0`]: {
      size: 2,
      limit: 100,
      isLastPage: true,
      start: 0,
      values: ['assets/nested/icon.svg', 'assets/sample.bin'],
    },
    [`${api}/browse/assets/sample.bin?at=${revision}&type=true`]: { type: 'FILE' },
    [`${api}/raw/assets/sample.bin?at=${revision}`]: binary,
    [`${api}/commits?limit=1&start=0&withCounts=false&until=feature%2Ftest`]: {
      size: 1,
      limit: 1,
      isLastPage: false,
      nextPageStart: 1,
      start: 0,
      values: [commit(second, [revision])],
    },
    [`${api}/commits?limit=1&start=1&withCounts=false&until=feature%2Ftest`]: {
      size: 1,
      limit: 1,
      isLastPage: true,
      start: 1,
      values: [{ ...commit(revision, [parent]), message: '' }],
    },
    [`${api}/commits/${second}/changes?limit=10000`]: {
      size: 5,
      limit: 10000,
      isLastPage: true,
      start: 0,
      values: [
        change('ADD', 'new.txt'),
        change('MODIFY', 'README.md'),
        change('DELETE', 'old.txt'),
        change('MOVE', 'after.txt', 'before.txt'),
        change('COPY', 'copy.txt', 'source.txt'),
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
    if (typeof value === 'function') {
      return value(init);
    }
    if (value instanceof Uint8Array) {
      return new Response(value);
    }
    return Response.json(value);
  };
  const endpoint = createBitbucketDataCenterEndpoint(
    `${target}/browse/src/index.ts?at=refs%2Fheads%2Fmain`,
    origin,
    () => 'dc-test-token',
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

function branch(name, latestCommit) {
  return {
    id: `refs/heads/${name}`,
    displayId: name,
    type: 'BRANCH',
    latestCommit,
    isDefault: name === 'main',
  };
}

function commit(id, parents) {
  return {
    id,
    displayId: id.slice(0, 12),
    parents: parents.map((value) => ({ id: value, displayId: value.slice(0, 12) })),
    message: 'A commit',
    author: { name: 'Example Author', emailAddress: 'author@example.test' },
    authorTimestamp: Date.parse('2026-09-24T12:00:00.000Z'),
  };
}

function change(type, path, srcPath) {
  return {
    type,
    nodeType: 'FILE',
    path: { toString: path },
    ...(srcPath === undefined ? {} : { srcPath: { toString: srcPath } }),
  };
}

function errorCode(code) {
  return (error) => error instanceof RemotishError && error.code === code;
}

test('Bitbucket Data Center endpoint derives project and personal targets from configured origin', () => {
  const token = () => 'test';
  const fetcher = async () => new Response('', { status: 404 });
  for (const url of [
    'https://evil.example/bitbucket/projects/PRJ/repos/widgets',
    `${origin}/bitbucket/projects/PRJ/repos`,
    `${origin}/bitbucket/projects/PRJ/not-repos/widgets`,
    `${origin}/bitbucket/projects/%2E%2E/repos/widgets`,
    `http://bitbucket.example.test/bitbucket/projects/PRJ/repos/widgets`,
  ]) {
    assert.equal(createBitbucketDataCenterEndpoint(url, origin, token, fetcher), undefined, url);
  }
  const project = createBitbucketDataCenterEndpoint(target, origin, token, fetcher);
  const personal = createBitbucketDataCenterEndpoint(
    `${server}users/alice/repos/scratch/browse`,
    origin,
    token,
    fetcher,
  );
  assert.equal(project?.target, target);
  assert.equal(personal?.target, `${server}users/alice/repos/scratch`);
  assert.deepEqual(project?.session, {
    version: 1,
    capabilities: { commits: false, createBranch: true, deleteBranch: true },
  });
});

test('Bitbucket Data Center read contract preserves identity, bytes, branches and history', async () => {
  const { adapter, calls } = fixture();
  assert.deepEqual(await adapter.getRepository(), {
    id: `bitbucket-datacenter:${encodeURIComponent(server)}:42`,
    name: 'Widgets',
    defaultBranch: 'main',
    description: 'A repository',
  });
  assert.deepEqual(await adapter.getBranches(), [
    { name: 'main', revision, isDefault: true },
    { name: 'feature/test', revision: second, isDefault: false },
  ]);
  assert.deepEqual(await adapter.readDirectory(revision, ''), [
    { name: 'README.md', path: 'README.md', type: 'file' },
    { name: 'assets', path: 'assets', type: 'directory' },
  ]);
  assert.deepEqual(await adapter.readDirectory(revision, 'assets'), [
    { name: 'nested', path: 'assets/nested', type: 'directory' },
    { name: 'sample.bin', path: 'assets/sample.bin', type: 'file' },
  ]);
  assert.deepEqual(await adapter.readFile(revision, 'assets/sample.bin'), binary);
  const firstPage = await adapter.getCommits({ branch: 'feature/test', limit: 1 });
  assert.deepEqual(
    firstPage.commits.map((item) => item.revision),
    [second],
  );
  assert.equal(firstPage.commits[0].authoredAt, '2026-09-24T12:00:00.000Z');
  assert.equal(firstPage.nextCursor, '1');
  const nextPage = await adapter.getCommits({
    branch: 'feature/test',
    limit: 1,
    cursor: firstPage.nextCursor,
  });
  assert.equal(nextPage.commits[0].revision, revision);
  assert.equal(nextPage.commits[0].message, '');
  assert.deepEqual(await adapter.getCommitChanges(second), [
    { type: 'added', path: 'new.txt' },
    { type: 'modified', path: 'README.md' },
    { type: 'deleted', path: 'old.txt' },
    { type: 'renamed', path: 'after.txt', previousPath: 'before.txt' },
    { type: 'added', path: 'copy.txt' },
  ]);
  assert.equal(adapter.capabilities.commits, false);
  assert.equal(adapter.commit, undefined);
  assert.equal(typeof adapter.createBranch, 'function');
  assert.equal(typeof adapter.deleteBranch, 'function');
  assert.equal(adapter.capabilities.forceWithLease, undefined);
  assert.equal(adapter.capabilities.amend, undefined);
  assert.ok(
    calls.every(
      ({ url, init }) =>
        url.startsWith(server) &&
        init.credentials === 'omit' &&
        init.redirect === 'manual' &&
        init.headers.Authorization === 'Bearer dc-test-token',
    ),
  );
});

test('Bitbucket Data Center personal repository uses tilde project key for REST calls', async () => {
  const calls = [];
  const personalTarget = `${server}users/alice/repos/scratch`;
  const endpoint = createBitbucketDataCenterEndpoint(
    `${personalTarget}/browse`,
    origin,
    () => 'token',
    async (input) => {
      calls.push(String(input));
      return Response.json({
        id: 7,
        name: 'Scratch',
        slug: 'scratch',
        scmId: 'git',
        defaultBranch: 'main',
        project: { key: '~alice' },
      });
    },
  );
  assert.ok(endpoint);
  assert.equal(
    (
      await endpoint.handle(
        { version: 1, operation: 'getRepository', payload: {} },
        new AbortController().signal,
      )
    ).id,
    `bitbucket-datacenter:${encodeURIComponent(server)}:7`,
  );
  assert.deepEqual(calls, [`${server}rest/api/1.0/projects/~alice/repos/scratch`]);
});

test('Bitbucket Data Center commit publication is rejected locally', async () => {
  const { endpoint, adapter, calls } = fixture();
  assert.equal(adapter.commit, undefined);
  const result = await endpoint.handle(
    {
      version: 1,
      operation: 'commit',
      payload: {
        type: 'commit',
        branch: 'main',
        baseRevision: revision,
        message: 'Update',
        changes: [{ type: 'add', path: 'new.txt', content: new Uint8Array([65]) }],
        push: { mode: 'force-with-lease', expectedRevision: revision },
      },
    },
    new AbortController().signal,
  );
  assert.deepEqual(result, {
    status: 'rejected',
    reason: 'UNSUPPORTED',
    message: 'Bitbucket Data Center REST does not provide atomic branch-head commit publication.',
  });
  assert.equal(calls.length, 0);
});

test('Bitbucket Data Center branch creation and deletion use branch-utils', async () => {
  const { adapter, calls } = fixture({
    [branchApi]: ({ method }) =>
      method === 'POST'
        ? Response.json(branch('feature/test', second), { status: 201 })
        : new Response(null, { status: 204 }),
  });
  assert.deepEqual(await adapter.createBranch('feature/test', second), {
    name: 'feature/test',
    revision: second,
  });
  await adapter.deleteBranch('feature/test');
  assert.equal(calls[0].url, branchApi);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    name: 'feature/test',
    startPoint: second,
  });
  assert.equal(calls[1].url, branchApi);
  assert.equal(calls[1].init.method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    name: 'refs/heads/feature/test',
    dryRun: false,
  });
});

test('Bitbucket Data Center validates responses, paths, cursors and API failures', async () => {
  const malformedRepo = fixture({ [api]: { id: 42, scmId: 'git', slug: 'other' } });
  await assert.rejects(malformedRepo.adapter.getRepository(), errorCode('UNKNOWN'));

  const escapedPath = fixture({
    [`${api}/files?at=${revision}&limit=100&start=0`]: {
      size: 1,
      limit: 100,
      isLastPage: true,
      start: 0,
      values: ['../escape'],
    },
  });
  await assert.rejects(escapedPath.adapter.readDirectory(revision, ''), errorCode('UNKNOWN'));

  const loop = fixture({
    [`${api}/branches?limit=100&start=0`]: {
      size: 0,
      limit: 100,
      isLastPage: false,
      nextPageStart: 0,
      start: 0,
      values: [],
    },
  });
  await assert.rejects(loop.adapter.getBranches(), errorCode('UNKNOWN'));

  await assert.rejects(
    fixture().adapter.getCommits({ branch: 'main', limit: 1, cursor: '-1' }),
    errorCode('INVALID_REQUEST'),
  );
  await assert.rejects(
    fixture().adapter.readFile('not-a-sha', 'README.md'),
    errorCode('INVALID_REQUEST'),
  );

  for (const [status, code] of [
    [400, 'INVALID_REQUEST'],
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'INVALID_REQUEST'],
    [429, 'RATE_LIMITED'],
    [503, 'OFFLINE'],
  ]) {
    const endpoint = createBitbucketDataCenterEndpoint(
      target,
      origin,
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

test('Bitbucket Data Center rejects missing tokens, redirects and oversized payloads', async () => {
  const missing = createBitbucketDataCenterEndpoint(
    target,
    origin,
    () => undefined,
    async () => new Response(''),
  );
  assert.ok(missing);
  await assert.rejects(
    missing.handle(
      { version: 1, operation: 'getRepository', payload: {} },
      new AbortController().signal,
    ),
    errorCode('UNAUTHORIZED'),
  );

  const redirected = fixture({
    [`${api}/raw/assets/sample.bin?at=${revision}`]: new Response(null, {
      status: 302,
      headers: { location: 'https://evil.example/file' },
    }),
  });
  await assert.rejects(
    redirected.adapter.readFile(revision, 'assets/sample.bin'),
    errorCode('UNSUPPORTED'),
  );
  assert.ok(redirected.calls.every(({ url }) => url.startsWith(server)));

  const submodule = fixture({
    [`${api}/browse/assets/sample.bin?at=${revision}&type=true`]: { type: 'SUBMODULE' },
  });
  await assert.rejects(
    submodule.adapter.readFile(revision, 'assets/sample.bin'),
    errorCode('UNSUPPORTED'),
  );
  assert.equal(
    submodule.calls.some(({ url }) => url === `${api}/raw/assets/sample.bin?at=${revision}`),
    false,
  );

  const largeFile = fixture({
    [`${api}/raw/assets/sample.bin?at=${revision}`]: new Response('x', {
      headers: { 'content-length': String(16 * 1024 * 1024 + 1) },
    }),
  });
  await assert.rejects(
    largeFile.adapter.readFile(revision, 'assets/sample.bin'),
    errorCode('UNSUPPORTED'),
  );

  const largeJson = fixture({
    [api]: new Response('x', {
      headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
    }),
  });
  await assert.rejects(largeJson.adapter.getRepository(), errorCode('UNSUPPORTED'));
});

test('Bitbucket Data Center rejects knowingly partial commit-change pages', async () => {
  const partial = fixture({
    [`${api}/commits/${second}/changes?limit=10000`]: {
      size: 1,
      limit: 1,
      isLastPage: false,
      nextPageStart: 1,
      start: 0,
      values: [change('MODIFY', 'README.md')],
    },
  });
  await assert.rejects(partial.adapter.getCommitChanges(second), errorCode('UNSUPPORTED'));
});
