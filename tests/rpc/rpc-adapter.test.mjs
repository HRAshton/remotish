import assert from 'node:assert/strict';
import test from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import {
  decodeRpcBytes,
  decodeRpcRequest,
  encodeRpcBytes,
  encodeRpcFailure,
  encodeRpcSuccess,
  RpcAdapter,
} from '@remotish/adapter-rpc';
import { RemotishError } from '@remotish/adapter-sdk';

const allCapabilities = {
  commits: true,
  forceWithLease: true,
  amend: true,
  createBranch: true,
  deleteBranch: true,
};
const session = (capabilities = allCapabilities) => ({ version: 1, capabilities });

function endpoint(backend = new FixtureAdapter()) {
  const calls = [];
  const transport = {
    async request(raw, options) {
      const { operation, payload } = decodeRpcRequest(structuredClone(raw));
      calls.push({ operation, payload, signal: options?.signal });
      let result;
      switch (operation) {
        case 'getRepository':
          result = await backend.getRepository(options);
          break;
        case 'readDirectory':
          result = await backend.readDirectory(payload.revision, payload.path, options);
          break;
        case 'readFile':
          result = await backend.readFile(payload.revision, payload.path, options);
          break;
        case 'getBranches':
          result = await backend.getBranches(options);
          break;
        case 'getCommits':
          result = await backend.getCommits(payload, options);
          break;
        case 'getCommitChanges':
          result = await backend.getCommitChanges(payload.revision, options);
          break;
        case 'commit':
          result = await backend.commit(payload, options);
          break;
        case 'createBranch':
          result = await backend.createBranch(payload.name, payload.revision, options);
          break;
        case 'deleteBranch':
          await backend.deleteBranch(payload.name, options);
          result = null;
          break;
      }
      return structuredClone(encodeRpcSuccess(operation, result));
    },
  };
  return { backend, calls, adapter: new RpcAdapter(transport, session()) };
}

test('RPC forwards every operation and preserves immutable bytes and opaque history cursor', async () => {
  const { adapter, calls } = endpoint();
  const repository = await adapter.getRepository();
  assert.equal(repository.defaultBranch, 'main');
  const branches = await adapter.getBranches();
  assert.equal(branches.find((branch) => branch.name === 'main').revision, 'C3');
  const entries = await adapter.readDirectory('C3', '');
  assert.ok(entries.some((entry) => entry.path === 'assets'));
  assert.deepEqual(
    await adapter.readFile('C3', 'assets/sample.bin'),
    new Uint8Array([0, 1, 2, 127, 128, 255]),
  );
  const page = await adapter.getCommits({ branch: 'main', limit: 2 });
  const next = await adapter.getCommits({ branch: 'main', limit: 2, cursor: page.nextCursor });
  assert.equal(next.commits[0].revision, 'C1');
  assert.ok((await adapter.getCommitChanges('C3')).some((change) => change.path === 'README.md'));
  const created = await adapter.createBranch('feature/new', 'C2');
  assert.deepEqual(created, { name: 'feature/new', revision: 'C2' });
  await adapter.deleteBranch('feature/new');
  assert.deepEqual(
    calls.map(({ operation }) => operation),
    [
      'getRepository',
      'getBranches',
      'readDirectory',
      'readFile',
      'getCommits',
      'getCommits',
      'getCommitChanges',
      'createBranch',
      'deleteBranch',
    ],
  );
});

test('binary codec round trips arbitrary bytes and rejects malformed encodings', () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  assert.deepEqual(decodeRpcBytes(encodeRpcBytes(bytes)), bytes);
  for (const bad of [{ base64: 'A===' }, { base64: 'AA' }, { base64: 12 }, {}]) {
    assert.throws(() => decodeRpcBytes(bad), RemotishError);
  }
});

test('normal publication succeeds remotely and stale base remains rejected', async () => {
  const { adapter, backend, calls } = endpoint();
  const request = {
    type: 'commit',
    branch: 'main',
    baseRevision: 'C3',
    message: 'Publish',
    changes: [{ type: 'modify', path: 'README.md', content: new Uint8Array([0, 255, 128]) }],
    push: { mode: 'normal' },
  };
  const published = await adapter.commit(request);
  assert.equal(published.status, 'success');
  assert.equal(backend.getBranchHead('main'), published.revision);
  assert.deepEqual(
    await adapter.readFile(published.revision, 'README.md'),
    new Uint8Array([0, 255, 128]),
  );
  assert.deepEqual(calls[0].payload.changes[0].content, new Uint8Array([0, 255, 128]));
  assert.equal((await adapter.commit(request)).reason, 'REMOTE_CHANGED');
});

test('force-with-lease and amend retain their distinct payloads and publication semantics', async () => {
  const { adapter, backend, calls } = endpoint();
  backend.moveBranchHead('main', 'F2');
  const force = await adapter.commit({
    type: 'commit',
    branch: 'main',
    baseRevision: 'C3',
    message: 'Force',
    changes: [{ type: 'delete', path: 'src/util.ts' }],
    push: { mode: 'force-with-lease', expectedRevision: 'F2' },
  });
  assert.equal(force.status, 'success');
  assert.deepEqual(force.commit.parents, ['C3']);
  assert.deepEqual(calls[0].payload.push, { mode: 'force-with-lease', expectedRevision: 'F2' });
  const amend = await adapter.commit({
    type: 'amend',
    branch: 'main',
    baseRevision: force.revision,
    message: 'Amend',
    changes: [],
    push: { mode: 'force-with-lease', expectedRevision: force.revision },
  });
  assert.equal(amend.status, 'success');
  assert.deepEqual(amend.commit.parents, ['C3']);
  assert.equal(calls[1].payload.type, 'amend');
  const stale = await adapter.commit({
    type: 'amend',
    branch: 'main',
    baseRevision: force.revision,
    message: 'Stale',
    changes: [],
    push: { mode: 'force-with-lease', expectedRevision: force.revision },
  });
  assert.equal(stale.reason, 'REMOTE_CHANGED');
});

test('session capabilities control optional methods and reject invalid combinations', async () => {
  const transport = { request: async () => encodeRpcSuccess('getBranches', []) };
  const readOnly = new RpcAdapter(transport, session({ commits: false }));
  assert.equal(readOnly.commit, undefined);
  assert.equal(readOnly.createBranch, undefined);
  assert.equal(readOnly.deleteBranch, undefined);
  const limited = new RpcAdapter(transport, session({ commits: true }));
  await assert.rejects(
    limited.commit({
      type: 'amend',
      branch: 'main',
      baseRevision: 'C3',
      message: 'No',
      changes: [],
      push: { mode: 'force-with-lease', expectedRevision: 'C3' },
    }),
    (error) => error.code === 'UNSUPPORTED',
  );
  for (const bad of [
    { version: 2, capabilities: { commits: false } },
    session({ commits: false, forceWithLease: true }),
    session({ commits: true, amend: true }),
    session({ commits: 'yes' }),
    session({ commits: false, surprise: true }),
  ]) {
    assert.throws(() => new RpcAdapter(transport, bad), RemotishError);
  }
});

test('known failures are classified; malformed failures and transport exceptions are safe', async () => {
  const make = (response) =>
    new RpcAdapter({ request: async () => response }, session({ commits: false }));
  await assert.rejects(
    make(encodeRpcFailure('NOT_FOUND')).getRepository(),
    (error) => error.code === 'NOT_FOUND' && !error.message.includes('secret'),
  );
  for (const response of [
    { version: 1, status: 'error', error: { code: 'SECRET', stack: 'secret' } },
    { version: 1, status: 'error', error: { code: 'WHATEVER' } },
    { version: 2, status: 'ok', result: {} },
  ]) {
    await assert.rejects(make(response).getRepository(), (error) => error.code === 'UNKNOWN');
  }
  const broken = new RpcAdapter(
    {
      request: async () => {
        throw new Error('secret');
      },
    },
    session(),
  );
  await assert.rejects(
    broken.getRepository(),
    (error) => error.code === 'OFFLINE' && !error.message.includes('secret'),
  );
  const misleading = new RpcAdapter(
    {
      request: async () => {
        throw new RemotishError('NOT_FOUND', 'secret response body');
      },
    },
    session(),
  );
  await assert.rejects(
    misleading.getRepository(),
    (error) => error.code === 'OFFLINE' && !error.message.includes('secret'),
  );
});

test('unknown request versions, names and malformed payloads fail closed', () => {
  for (const request of [
    { version: 2, operation: 'getRepository', payload: {} },
    { version: 1, operation: 'eraseEverything', payload: {} },
    { version: 1, operation: 'readFile', payload: { revision: 'C3', path: '../secret' } },
    {
      version: 1,
      operation: 'commit',
      payload: {
        type: 'amend',
        branch: 'main',
        baseRevision: 'C3',
        message: 'x',
        changes: [],
        push: { mode: 'normal' },
      },
    },
  ]) {
    assert.throws(() => decodeRpcRequest(request), RemotishError);
  }
});

test('every result category rejects malformed remote data', async () => {
  const cases = [
    ['getRepository', {}, { id: 'x', name: 'X', defaultBranch: 3 }],
    ['readDirectory', { revision: 'C3', path: '' }, [{ name: 'x', path: '../x', type: 'file' }]],
    ['readFile', { revision: 'C3', path: 'x' }, { base64: 'not bytes' }],
    ['getBranches', {}, [{ name: 'main', revision: 3 }]],
    ['getCommits', {}, { commits: [{ revision: 'C3', parents: 'bad', message: 'x' }] }],
    ['getCommitChanges', { revision: 'C3' }, [{ type: 'other', path: 'x' }]],
    [
      'commit',
      {},
      { status: 'success', revision: 'C4', commit: { revision: 'C5', parents: [], message: 'x' } },
    ],
    ['createBranch', {}, { name: 'x', revision: null }],
    ['deleteBranch', {}, {}],
  ];
  const { decodeRpcResponse } = await import('@remotish/adapter-rpc');
  for (const [operation, _payload, result] of cases) {
    assert.throws(
      () => decodeRpcResponse(operation, { version: 1, status: 'ok', result }),
      RemotishError,
      operation,
    );
  }
});

test('directory results contain only immediate children of the requested directory', async () => {
  const adapter = new RpcAdapter(
    {
      request: async () => ({
        version: 1,
        status: 'ok',
        result: [{ name: 'child.ts', path: 'other/child.ts', type: 'file' }],
      }),
    },
    session({ commits: false }),
  );
  await assert.rejects(adapter.readDirectory('C3', 'src'), (error) => error.code === 'UNKNOWN');
});

test('local abort reaches transport and late response cannot resolve the cancelled call', async () => {
  let resolveRemote;
  let passedSignal;
  const transport = {
    request: (_request, options) => {
      passedSignal = options.signal;
      return new Promise((resolve) => {
        resolveRemote = resolve;
      });
    },
  };
  const adapter = new RpcAdapter(transport, session({ commits: false }));
  const controller = new AbortController();
  const pending = adapter.getRepository({ signal: controller.signal });
  await Promise.resolve();
  assert.equal(passedSignal, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'CANCELLED');
  resolveRemote(encodeRpcSuccess('getRepository', { id: 'x', name: 'X', defaultBranch: 'main' }));
  await assert.rejects(
    adapter.getRepository({ signal: controller.signal }),
    (error) => error.code === 'CANCELLED',
  );
});
