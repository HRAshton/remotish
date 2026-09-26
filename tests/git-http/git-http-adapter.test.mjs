import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryWorkspaceStorage, RemotishWorkspace } from '@remotish/core';
import { GitHttpAdapter, GitHttpNotDispatchedError } from '../../adapters/git-http/dist/index.js';

const GIT_URL = 'https://git.example.invalid/repo.git';
const author = { name: 'Pilot Author', email: 'pilot@example.invalid' };
const providerRequire = createRequire(
  new URL('../../extensions/git-http-provider/package.json', import.meta.url),
);
const { createFsFromVolume, Volume } = providerRequire('memfs');

function run(directory, ...args) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

async function startRepository(t, fs) {
  const root = await mkdtemp(join(tmpdir(), 'remotish-git-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bare = join(root, 'repo.git');
  const working = join(root, 'working');
  await mkdir(working);
  run(root, 'init', '--bare', bare);
  run(root, 'config', '--file', join(bare, 'config'), 'http.receivepack', 'true');
  run(working, 'init');
  await writeFile(join(working, 'binary.bin'), Uint8Array.of(0, 255, 1, 13, 10));
  await writeFile(join(working, 'hello.txt'), 'first\n');
  run(working, 'add', '.');
  run(
    working,
    '-c',
    'user.name=Initial',
    '-c',
    'user.email=initial@example.invalid',
    'commit',
    '-m',
    'Initial',
  );
  run(working, 'remote', 'add', 'origin', bare);
  run(working, 'push', 'origin', 'HEAD:main');
  run(root, '--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');

  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    const path = new URL(request.url ?? '/', 'http://localhost');
    const child = spawn('git', ['http-backend'], {
      cwd: root,
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: path.pathname,
        QUERY_STRING: path.search.slice(1),
        REQUEST_METHOD: request.method ?? 'GET',
        CONTENT_TYPE: request.headers['content-type'] ?? '',
        CONTENT_LENGTH: String(body.length),
        REMOTE_USER: 'pilot',
      },
    });
    child.stdin.end(body);
    const output = [];
    for await (const chunk of child.stdout) {
      output.push(chunk);
    }
    const data = Buffer.concat(output);
    const headerEnd = data.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      response.writeHead(500).end();
      return;
    }
    const header = data.subarray(0, headerEnd).toString('latin1');
    let status = 200;
    for (const line of header.split('\r\n')) {
      const separator = line.indexOf(':');
      if (separator < 0) {
        continue;
      }
      const name = line.slice(0, separator);
      const value = line.slice(separator + 1).trim();
      if (name.toLowerCase() === 'status') {
        status = Number.parseInt(value, 10);
      } else {
        response.setHeader(name, value);
      }
    }
    response.writeHead(status).end(data.subarray(headerEnd + 4));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const request = async (input) => {
    const target = new URL(input.url);
    const response = await fetch(`${endpoint}${target.pathname}${target.search}`, {
      method: input.method,
      headers: input.headers,
      ...(input.method === 'POST' ? { body: input.body } : {}),
      redirect: 'manual',
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: new Uint8Array(await response.arrayBuffer()),
    };
  };
  const adapter = new GitHttpAdapter({ url: GIT_URL, author, request, ...(fs ? { fs } : {}) });
  return { adapter, request, bare, working, root };
}

test('desktop heap filesystem supports Git fetch and immutable reads', async (t) => {
  const { adapter } = await startRepository(t, createFsFromVolume(new Volume()));
  const branch = (await adapter.getBranches()).find((item) => item.name === 'main');
  assert.ok(branch);
  assert.deepEqual(
    await adapter.readFile(branch.revision, 'binary.bin'),
    Uint8Array.of(0, 255, 1, 13, 10),
  );
});

test('Git HTTP fetch maps remote failures to stable error codes', async (t) => {
  const { request } = await startRepository(t);
  for (const [status, code] of [
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [429, 'RATE_LIMITED'],
    [503, 'OFFLINE'],
  ]) {
    const adapter = new GitHttpAdapter({
      url: GIT_URL,
      author,
      request: async (input) =>
        input.url.includes('service=git-upload-pack')
          ? { status, headers: {}, body: new Uint8Array() }
          : request(input),
    });
    await assert.rejects(adapter.getRepository(), (error) => error.code === code);
  }
  const offline = new GitHttpAdapter({
    url: GIT_URL,
    author,
    request: async () => {
      throw new TypeError('network failed');
    },
  });
  await assert.rejects(offline.getRepository(), (error) => error.code === 'OFFLINE');
  const malformed = new GitHttpAdapter({
    url: GIT_URL,
    author,
    request: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
  });
  await assert.rejects(malformed.getRepository(), (error) => error.code === 'UNKNOWN');
});

test('Git HTTP reads immutable binary content and publishes a multi-file change', async (t) => {
  const { adapter, bare, root } = await startRepository(t);
  const repository = await adapter.getRepository();
  assert.equal(repository.defaultBranch, 'main');
  const original = (await adapter.getBranches()).find((item) => item.name === 'main');
  assert.ok(original);
  assert.deepEqual(
    await adapter.readFile(original.revision, 'binary.bin'),
    Uint8Array.of(0, 255, 1, 13, 10),
  );
  assert.deepEqual(
    (await adapter.readDirectory(original.revision, '')).map((entry) => entry.name).sort(),
    ['binary.bin', 'hello.txt'],
  );
  const result = await adapter.commit({
    type: 'commit',
    branch: 'main',
    baseRevision: original.revision,
    message: 'Two files',
    changes: [
      { type: 'modify', path: 'hello.txt', content: new TextEncoder().encode('second\n') },
      { type: 'add', path: 'added.bin', content: Uint8Array.of(255, 0, 254) },
    ],
    push: { mode: 'normal' },
  });
  assert.equal(result.status, 'success');
  assert.equal(run(root, '--git-dir', bare, 'rev-parse', 'refs/heads/main'), result.revision);
  assert.equal(
    new TextDecoder().decode(await adapter.readFile(original.revision, 'hello.txt')),
    'first\n',
  );
  assert.deepEqual(
    await adapter.readFile(result.revision, 'added.bin'),
    Uint8Array.of(255, 0, 254),
  );
  assert.deepEqual(
    (await adapter.getCommitChanges(result.revision)).map(
      (change) => `${change.type}:${change.path}`,
    ),
    ['added:added.bin', 'modified:hello.txt'],
  );
});

test('Git HTTP rejects gitlinks and symlinks as file entries', async (t) => {
  const { adapter, working } = await startRepository(t);
  const original = (await adapter.getBranches()).find((item) => item.name === 'main');
  assert.ok(original);
  await writeFile(join(working, 'link'), 'hello.txt');
  const linkOid = run(working, 'hash-object', '-w', 'link');
  run(working, 'update-index', '--add', '--cacheinfo', `120000,${linkOid},link`);
  run(working, 'update-index', '--add', '--cacheinfo', `160000,${original.revision},submodule`);
  run(
    working,
    '-c',
    'user.name=External',
    '-c',
    'user.email=external@example.invalid',
    'commit',
    '-m',
    'Special entries',
  );
  run(working, 'push', 'origin', 'HEAD:main');
  const current = (await adapter.getBranches()).find((item) => item.name === 'main');
  assert.ok(current);
  await assert.rejects(
    adapter.readDirectory(current.revision, ''),
    (error) => error.code === 'UNSUPPORTED',
  );
  await assert.rejects(
    adapter.readFile(current.revision, 'link'),
    (error) => error.code === 'UNSUPPORTED',
  );
  await assert.rejects(
    adapter.readFile(current.revision, 'submodule'),
    (error) => error.code === 'UNSUPPORTED',
  );
  await assert.rejects(
    adapter.getCommitChanges(current.revision),
    (error) => error.code === 'UNSUPPORTED',
  );
});

test('Git HTTP rejects stale normal publication and keeps amend parentage', async (t) => {
  const { adapter, bare, working, root } = await startRepository(t);
  const original = (await adapter.getBranches()).find((item) => item.name === 'main');
  assert.ok(original);
  await writeFile(join(working, 'hello.txt'), 'external\n');
  run(working, 'add', '.');
  run(
    working,
    '-c',
    'user.name=External',
    '-c',
    'user.email=external@example.invalid',
    'commit',
    '-m',
    'External',
  );
  run(working, 'push', 'origin', 'HEAD:main');
  const moved = run(root, '--git-dir', bare, 'rev-parse', 'refs/heads/main');
  const stale = await adapter.commit({
    type: 'commit',
    branch: 'main',
    baseRevision: original.revision,
    message: 'Stale',
    changes: [{ type: 'modify', path: 'hello.txt', content: new TextEncoder().encode('stale\n') }],
    push: { mode: 'normal' },
  });
  assert.deepEqual(stale, { status: 'rejected', reason: 'REMOTE_CHANGED', remoteRevision: moved });
  assert.equal(run(root, '--git-dir', bare, 'rev-parse', 'refs/heads/main'), moved);
  const staleLease = await adapter.commit({
    type: 'amend',
    branch: 'main',
    baseRevision: original.revision,
    message: 'Stale lease',
    changes: [
      { type: 'modify', path: 'hello.txt', content: new TextEncoder().encode('stale lease\n') },
    ],
    push: { mode: 'force-with-lease', expectedRevision: original.revision },
  });
  assert.deepEqual(staleLease, {
    status: 'rejected',
    reason: 'REMOTE_CHANGED',
    remoteRevision: moved,
  });
  assert.equal(run(root, '--git-dir', bare, 'rev-parse', 'refs/heads/main'), moved);
  const amended = await adapter.commit({
    type: 'amend',
    branch: 'main',
    baseRevision: original.revision,
    message: 'Amended',
    changes: [
      { type: 'modify', path: 'hello.txt', content: new TextEncoder().encode('amended\n') },
    ],
    push: { mode: 'force-with-lease', expectedRevision: moved },
  });
  assert.equal(amended.status, 'success');
  assert.deepEqual(amended.commit.parents, []);
  assert.equal(run(root, '--git-dir', bare, 'rev-parse', 'refs/heads/main'), amended.revision);
});

test('Git HTTP pages history and creates and deletes real remote branches', async (t) => {
  const { adapter, bare, root } = await startRepository(t);
  const original = (await adapter.getBranches()).find((item) => item.name === 'main');
  assert.ok(original);
  const created = await adapter.createBranch('feature/test', original.revision);
  assert.deepEqual(created, { name: 'feature/test', revision: original.revision });
  assert.equal(
    run(root, '--git-dir', bare, 'rev-parse', 'refs/heads/feature/test'),
    original.revision,
  );
  const published = await adapter.commit({
    type: 'commit',
    branch: 'main',
    baseRevision: original.revision,
    message: 'Second',
    changes: [{ type: 'add', path: 'second.txt', content: new TextEncoder().encode('second') }],
    push: { mode: 'normal' },
  });
  assert.equal(published.status, 'success');
  const firstPage = await adapter.getCommits({ branch: 'main', limit: 1 });
  assert.equal(firstPage.commits[0].revision, published.revision);
  assert.ok(firstPage.nextCursor);
  const secondPage = await adapter.getCommits({
    branch: 'main',
    limit: 1,
    cursor: firstPage.nextCursor,
  });
  assert.equal(secondPage.commits[0].revision, original.revision);
  assert.equal(secondPage.nextCursor, undefined);
  await adapter.deleteBranch('feature/test');
  assert.equal(run(root, '--git-dir', bare, 'branch', '--list', 'feature/test'), '');
});

test('pre-dispatch refusal settles workspace journal and preserves overlay', async (t) => {
  const { request, bare, root } = await startRepository(t);
  let refused = false;
  const adapter = new GitHttpAdapter({
    url: GIT_URL,
    author,
    request: async (input) => {
      if (input.url.endsWith('/git-receive-pack')) {
        refused = true;
        throw new GitHttpNotDispatchedError(
          'UNSUPPORTED',
          'Bridge request exceeded its size limit.',
        );
      }
      return request(input);
    },
  });
  const workspace = await RemotishWorkspace.open(adapter, new MemoryWorkspaceStorage());
  const original = workspace.baseRevision;
  await workspace.writeFile('hello.txt', new TextEncoder().encode('local\n'), {
    create: false,
    overwrite: true,
  });
  const result = await workspace.commitAndPush('Pre-dispatch refusal');
  assert.equal(refused, true);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'UNSUPPORTED');
  assert.equal(workspace.pendingPublication, undefined);
  assert.equal(workspace.hasChanges, true);
  assert.equal(run(root, '--git-dir', bare, 'rev-parse', 'refs/heads/main'), original);
});

test('ambiguous receive-pack failure never reports publication success', async (t) => {
  const { request, bare, root } = await startRepository(t);
  let failed = false;
  const adapter = new GitHttpAdapter({
    url: GIT_URL,
    author,
    request: async (input) => {
      const response = await request(input);
      if (!failed && input.url.endsWith('/git-receive-pack')) {
        failed = true;
        throw new TypeError('Connection lost after server ref update.');
      }
      return response;
    },
  });
  const original = (await adapter.getBranches()).find((item) => item.name === 'main');
  assert.ok(original);
  await assert.rejects(
    adapter.commit({
      type: 'commit',
      branch: 'main',
      baseRevision: original.revision,
      message: 'Ambiguous',
      changes: [
        { type: 'add', path: 'ambiguous.txt', content: new TextEncoder().encode('published') },
      ],
      push: { mode: 'normal' },
    }),
    (error) => error.code === 'OFFLINE',
  );
  assert.equal(failed, true);
  assert.notEqual(run(root, '--git-dir', bare, 'rev-parse', 'refs/heads/main'), original.revision);
});

test('Git receive-pack rejects a head change after advertisement', async (t) => {
  const { request, bare, working, root } = await startRepository(t);
  let moved;
  const adapter = new GitHttpAdapter({
    url: GIT_URL,
    author,
    request: async (input) => {
      const response = await request(input);
      if (moved === undefined && input.url.includes('service=git-receive-pack')) {
        await writeFile(join(working, 'hello.txt'), 'raced\n');
        run(working, 'add', '.');
        run(
          working,
          '-c',
          'user.name=External',
          '-c',
          'user.email=external@example.invalid',
          'commit',
          '-m',
          'Raced',
        );
        run(working, 'push', 'origin', 'HEAD:main');
        moved = run(root, '--git-dir', bare, 'rev-parse', 'refs/heads/main');
      }
      return response;
    },
  });
  const original = (await adapter.getBranches()).find((item) => item.name === 'main');
  assert.ok(original);
  const result = await adapter.commit({
    type: 'commit',
    branch: 'main',
    baseRevision: original.revision,
    message: 'Losing race',
    changes: [{ type: 'add', path: 'race.txt', content: new TextEncoder().encode('local') }],
    push: { mode: 'normal' },
  });
  assert.deepEqual(result, { status: 'rejected', reason: 'REMOTE_CHANGED', remoteRevision: moved });
  assert.equal(run(root, '--git-dir', bare, 'rev-parse', 'refs/heads/main'), moved);
});
