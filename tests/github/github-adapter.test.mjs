import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubAdapter } from '@remotish/adapter-github';
import { RemotishError } from '@remotish/adapter-sdk';

const encoder = new TextEncoder();

function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers });
}

function createGitHubFetch({ rejectUpdate = false } = {}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });

    if (url.pathname === '/repos/acme/demo') {
      return json({
        id: 1,
        node_id: 'R_repo',
        name: 'demo',
        full_name: 'acme/demo',
        description: 'Demo',
        default_branch: 'main',
      });
    }
    if (url.pathname === '/repos/acme/demo/branches') {
      return json([{ name: 'main', commit: { sha: 'C1' } }]);
    }
    if (url.pathname === '/repos/acme/demo/git/commits/C1') {
      return json({
        sha: 'C1',
        message: 'Initial',
        tree: { sha: 'T1' },
        parents: [],
        author: { name: 'A', email: 'a@example.test', date: '2026-01-01T00:00:00Z' },
      });
    }
    if (url.pathname === '/repos/acme/demo/git/trees/T1') {
      return json({
        sha: 'T1',
        tree: [
          { path: 'README.md', mode: '100644', type: 'blob', sha: 'B1', size: 5 },
          { path: 'bin', mode: '040000', type: 'tree', sha: 'TBIN' },
        ],
      });
    }
    if (url.pathname === '/repos/acme/demo/git/blobs/B1' && init.method !== 'POST') {
      return json({ content: 'aGVsbG8=', encoding: 'base64' });
    }
    if (url.pathname === '/repos/acme/demo/git/blobs' && init.method === 'POST') {
      return json({ sha: 'B2' }, 201);
    }
    if (url.pathname === '/repos/acme/demo/git/trees' && init.method === 'POST') {
      return json({ sha: 'T2' }, 201);
    }
    if (url.pathname === '/repos/acme/demo/git/commits' && init.method === 'POST') {
      return json(
        {
          sha: 'C2',
          message: 'Update',
          tree: { sha: 'T2' },
          parents: [{ sha: 'C1' }],
          author: { name: 'A', date: '2026-01-02T00:00:00Z' },
        },
        201,
      );
    }
    if (url.pathname === '/graphql') {
      return rejectUpdate
        ? json({ errors: [{ message: 'beforeOid did not match' }] })
        : json({ data: { updateRefs: { clientMutationId: null } } });
    }
    if (url.pathname === '/repos/acme/demo/git/ref/heads/main') {
      return json({ object: { sha: 'C9' } });
    }

    throw new Error(`Unexpected GitHub request: ${init.method ?? 'GET'} ${url}`);
  };
  return { fetch, calls };
}

test('github adapter: public repositories are readable without authentication', async () => {
  const { fetch } = createGitHubFetch();
  const adapter = new GitHubAdapter({ owner: 'acme', repository: 'demo', fetch });

  assert.equal(adapter.capabilities.commits, false);
  assert.equal((await adapter.getRepository()).defaultBranch, 'main');
  assert.deepEqual(await adapter.getBranches(), [
    { name: 'main', revision: 'C1', isDefault: true },
  ]);
  assert.deepEqual(await adapter.readDirectory('C1', ''), [
    { name: 'bin', path: 'bin', type: 'directory' },
    { name: 'README.md', path: 'README.md', type: 'file', size: 5 },
  ]);
  assert.equal(new TextDecoder().decode(await adapter.readFile('C1', 'README.md')), 'hello');
});

test('github adapter: normal publish uses an atomic beforeOid ref update', async () => {
  const { fetch, calls } = createGitHubFetch();
  const adapter = new GitHubAdapter({
    owner: 'acme',
    repository: 'demo',
    token: 'test-token',
    fetch,
  });

  const result = await adapter.commit({
    type: 'commit',
    branch: 'main',
    baseRevision: 'C1',
    message: 'Update',
    changes: [{ type: 'modify', path: 'README.md', content: encoder.encode('world') }],
    push: { mode: 'normal' },
  });

  assert.equal(result.status, 'success');
  const graphql = calls.find((call) => new URL(call.url).pathname === '/graphql');
  const body = JSON.parse(String(graphql.init.body));
  assert.equal(body.variables.input.refUpdates[0].beforeOid, 'C1');
  assert.equal(body.variables.input.refUpdates[0].afterOid, 'C2');
  assert.equal(body.variables.input.refUpdates[0].force, false);
});

test('github adapter: failed lease becomes REMOTE_CHANGED without losing local semantics', async () => {
  const { fetch } = createGitHubFetch({ rejectUpdate: true });
  const adapter = new GitHubAdapter({
    owner: 'acme',
    repository: 'demo',
    token: 'test-token',
    fetch,
  });

  const result = await adapter.commit({
    type: 'commit',
    branch: 'main',
    baseRevision: 'C1',
    message: 'Update',
    changes: [{ type: 'modify', path: 'README.md', content: encoder.encode('world') }],
    push: { mode: 'normal' },
  });

  assert.deepEqual(result, {
    status: 'rejected',
    reason: 'REMOTE_CHANGED',
    remoteRevision: 'C9',
    message: 'Remote branch moved from C1 to C9.',
  });
});

test('github adapter: rejects malformed GitHub JSON at the transport boundary', async () => {
  const fetch = async () =>
    json({
      id: 'not-a-number',
      node_id: 'R_repo',
      name: 'demo',
      full_name: 'acme/demo',
      description: null,
      default_branch: 'main',
    });
  const adapter = new GitHubAdapter({ owner: 'acme', repository: 'demo', fetch });

  await assert.rejects(
    adapter.getRepository(),
    (error) =>
      error?.code === 'UNKNOWN' &&
      String(error.message).includes('Invalid GitHub response: repository.id'),
  );
});

test('github adapter: rejects plaintext remote API URLs but permits loopback development HTTP', () => {
  assert.throws(
    () =>
      new GitHubAdapter({
        owner: 'acme',
        repository: 'demo',
        token: 'secret',
        apiBaseUrl: 'http://github.example.invalid/api/v3',
        fetch: async () => json({}),
      }),
    (error) => error instanceof RemotishError && error.code === 'INVALID_REQUEST',
  );

  assert.doesNotThrow(
    () =>
      new GitHubAdapter({
        owner: 'acme',
        repository: 'demo',
        apiBaseUrl: 'http://localhost:3000/api/v3',
        fetch: async () => json({}),
      }),
  );
});

test('github adapter: enforces bounded response bodies', async () => {
  const adapter = new GitHubAdapter({
    owner: 'acme',
    repository: 'demo',
    maxResponseBytes: 16,
    fetch: async () =>
      json({
        id: 1,
        node_id: 'R_repo',
        name: 'demo',
        full_name: 'acme/demo',
        description: null,
        default_branch: 'main',
      }),
  });

  await assert.rejects(
    adapter.getRepository(),
    (error) => error instanceof RemotishError && error.code === 'UNSUPPORTED',
  );
});
