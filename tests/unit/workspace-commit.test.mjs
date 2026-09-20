import assert from 'node:assert/strict';
import test from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import { RemotishError } from '@remotish/adapter-sdk';
import { MemoryWorkspaceStorage, RemotishWorkspace } from '@remotish/core';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test('workspace commit: success rebinds to returned remote revision and clears changes', async () => {
  const adapter = new FixtureAdapter();
  const workspace = await RemotishWorkspace.open(adapter);
  await workspace.writeFile('README.md', encoder.encode('published\n'), {
    create: false,
    overwrite: true,
  });

  const result = await workspace.commitAndPush('Publish change');
  assert.equal(result.status, 'success');
  if (result.status !== 'success') {
    return;
  }

  assert.equal(workspace.baseRevision, result.revision);
  assert.equal(workspace.hasChanges, false);
  assert.equal(adapter.getBranchHead('main'), result.revision);
  assert.equal(decoder.decode(await workspace.readFile('README.md')), 'published\n');
});

test('workspace commit: rejection leaves base and working changes untouched', async () => {
  const adapter = new FixtureAdapter();
  const workspace = await RemotishWorkspace.open(adapter);
  await workspace.writeFile('README.md', encoder.encode('local\n'), {
    create: false,
    overwrite: true,
  });
  adapter.moveBranchHead('main', 'F2');

  const result = await workspace.commitAndPush('Will reject');
  assert.equal(result.status, 'rejected');
  assert.equal(workspace.baseRevision, 'C3');
  assert.equal(workspace.hasChanges, true);
  assert.equal(decoder.decode(await workspace.readFile('README.md')), 'local\n');

  const forced = await workspace.commitAndPushForceWithLease('Force safely', 'F2');
  assert.equal(forced.status, 'success');
  if (forced.status !== 'success') {
    return;
  }
  assert.equal(workspace.baseRevision, forced.revision);
  assert.equal(workspace.hasChanges, false);
  assert.deepEqual(forced.commit.parents, ['C3']);
});

test('workspace amend: rewrites current remote commit using a lease', async () => {
  const adapter = new FixtureAdapter();
  const workspace = await RemotishWorkspace.open(adapter);
  await workspace.writeFile('README.md', encoder.encode('amended\n'), {
    create: false,
    overwrite: true,
  });

  const result = await workspace.amendAndPushForceWithLease('Rewrite C3');
  assert.equal(result.status, 'success');
  if (result.status !== 'success') {
    return;
  }
  assert.deepEqual(result.commit.parents, ['C2']);
  assert.equal(workspace.baseRevision, result.revision);
  assert.equal(workspace.hasChanges, false);
});

test('workspace branches: overlays and bases are independent and persist', async () => {
  const adapter = new FixtureAdapter();
  const storage = new MemoryWorkspaceStorage();
  const first = await RemotishWorkspace.open(adapter, storage);

  await first.writeFile('README.md', encoder.encode('main local\n'), {
    create: false,
    overwrite: true,
  });
  await first.switchBranch('feature/test');
  assert.equal(first.baseRevision, 'F2');
  await first.writeFile('README.md', encoder.encode('feature local\n'), {
    create: false,
    overwrite: true,
  });

  const restored = await RemotishWorkspace.open(adapter, storage);
  assert.equal(restored.branch, 'feature/test');
  assert.equal(restored.baseRevision, 'F2');
  assert.equal(decoder.decode(await restored.readFile('README.md')), 'feature local\n');

  await restored.switchBranch('main');
  assert.equal(restored.baseRevision, 'C3');
  assert.equal(decoder.decode(await restored.readFile('README.md')), 'main local\n');
});

test('workspace amend: can rewrite only the commit message without working changes', async () => {
  const adapter = new FixtureAdapter();
  const workspace = await RemotishWorkspace.open(adapter);

  const result = await workspace.amendAndPushForceWithLease('Rewrite message only');
  assert.equal(result.status, 'success');
  if (result.status !== 'success') {
    return;
  }

  assert.deepEqual(result.commit.parents, ['C2']);
  assert.equal(result.commit.message, 'Rewrite message only');
  assert.equal(workspace.baseRevision, result.revision);
  assert.equal(workspace.hasChanges, false);
});

test('workspace guarded mutations reject if the selected branch or base changed', async () => {
  const adapter = new FixtureAdapter();
  const workspace = await RemotishWorkspace.open(adapter);
  const expectedState = { branch: workspace.branch, baseRevision: workspace.baseRevision };

  await workspace.switchBranch('feature/test');

  await assert.rejects(
    workspace.amendAndPushForceWithLease('Do not rewrite feature', undefined, expectedState),
    (error) => error instanceof RemotishError && error.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    workspace.commitAndPushForceWithLease(
      'Do not force feature',
      'F2',
      undefined,
      expectedState,
    ),
    (error) => error instanceof RemotishError && error.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    workspace.createBranch('feature/raced', true, expectedState),
    (error) => error instanceof RemotishError && error.code === 'INVALID_REQUEST',
  );

  assert.equal(adapter.getBranchHead('feature/test'), 'F2');
  assert.equal(
    (await workspace.listBranches()).some((branch) => branch.name === 'feature/raced'),
    false,
  );
});

test('workspace mutations: persistence failure rolls back local state', async () => {
  const storage = {
    async load() {
      return undefined;
    },
    async save() {
      throw new Error('disk full');
    },
    async delete() {},
  };
  const workspace = await RemotishWorkspace.open(new FixtureAdapter(), storage);
  const before = await workspace.readFile('README.md');
  const events = [];
  workspace.onDidChange((event) => events.push(event));

  await assert.rejects(
    workspace.writeFile('README.md', encoder.encode('changed'), {
      create: false,
      overwrite: true,
    }),
    /disk full/u,
  );

  assert.deepEqual(await workspace.readFile('README.md'), before);
  assert.equal(workspace.hasChanges, false);
  assert.deepEqual(events, []);
});

test('workspace amend: persistence failure after publication does not report failure', async () => {
  const adapter = new FixtureAdapter();
  const storage = {
    async load() {
      return undefined;
    },
    async save() {
      throw new Error('disk full');
    },
    async delete() {},
  };
  const workspace = await RemotishWorkspace.open(adapter, storage);
  const events = [];
  workspace.onDidChange((event) => events.push(event));

  const result = await workspace.amendAndPushForceWithLease(
    'Published despite persistence failure',
  );
  assert.equal(result.status, 'success');
  if (result.status !== 'success') {
    return;
  }

  assert.equal(adapter.getBranchHead('main'), result.revision);
  assert.equal(workspace.baseRevision, result.revision);
  assert.deepEqual(events, [{ branch: 'main', baseRevision: result.revision }]);
});

test('workspace branches: persistence failure after creation does not report failure', async () => {
  const adapter = new FixtureAdapter();
  const storage = {
    async load() {
      return undefined;
    },
    async save() {
      throw new Error('disk full');
    },
    async delete() {},
  };
  const workspace = await RemotishWorkspace.open(adapter, storage);

  const created = await workspace.createBranch('feature/persistence-failure');

  assert.equal(workspace.branch, created.name);
  assert.equal(
    (await workspace.listBranches()).some((branch) => branch.name === created.name),
    true,
  );
});

test('workspace branches: create and delete are remote operations owned by core', async () => {
  const adapter = new FixtureAdapter();
  const workspace = await RemotishWorkspace.open(adapter);

  const created = await workspace.createBranch('feature/new');
  assert.equal(created.name, 'feature/new');
  assert.equal(created.revision, 'C3');
  assert.equal(workspace.branch, 'feature/new');
  assert.equal(workspace.baseRevision, 'C3');

  await workspace.switchBranch('main');
  await workspace.deleteBranch('feature/new');
  assert.equal(
    (await workspace.listBranches()).some((branch) => branch.name === 'feature/new'),
    false,
  );
  await assert.rejects(
    workspace.switchBranch('feature/new'),
    (error) => error instanceof RemotishError && error.code === 'NOT_FOUND',
  );
  await assert.rejects(workspace.deleteBranch('main'));
});

test('workspace refresh: clean workspace can advance, dirty workspace stays pinned', async () => {
  const cleanAdapter = new FixtureAdapter();
  const clean = await RemotishWorkspace.open(cleanAdapter);
  cleanAdapter.moveBranchHead('main', 'F2');
  const updated = await clean.refreshRemoteHead();
  assert.deepEqual(updated, { status: 'updated', baseRevision: 'F2', remoteRevision: 'F2' });
  assert.equal(clean.baseRevision, 'F2');

  const dirtyAdapter = new FixtureAdapter();
  const dirty = await RemotishWorkspace.open(dirtyAdapter);
  await dirty.writeFile('README.md', encoder.encode('local\n'), { create: false, overwrite: true });
  dirtyAdapter.moveBranchHead('main', 'F2');
  const pinned = await dirty.refreshRemoteHead();
  assert.deepEqual(pinned, { status: 'pinned', baseRevision: 'C3', remoteRevision: 'F2' });
  assert.equal(dirty.baseRevision, 'C3');
  assert.equal(decoder.decode(await dirty.readFile('README.md')), 'local\n');
});

test('workspace commit: selected paths publish while unselected changes stay in the overlay', async () => {
  const adapter = new FixtureAdapter();
  const workspace = await RemotishWorkspace.open(adapter);

  await workspace.writeFile('README.md', encoder.encode('selected\n'), {
    create: false,
    overwrite: true,
  });
  await workspace.writeFile(
    'src/index.ts',
    encoder.encode("export const greeting = 'unselected';\n"),
    {
      create: false,
      overwrite: true,
    },
  );

  const result = await workspace.commitAndPush('Publish README only', ['README.md']);
  assert.equal(result.status, 'success');
  if (result.status !== 'success') {
    return;
  }

  assert.equal(workspace.baseRevision, result.revision);
  assert.equal(workspace.hasChanges, true);
  assert.deepEqual(await workspace.getChanges(), [{ type: 'modified', path: 'src/index.ts' }]);
  assert.equal(decoder.decode(await adapter.readFile(result.revision, 'README.md')), 'selected\n');
  assert.equal(
    decoder.decode(await adapter.readFile(result.revision, 'src/index.ts')),
    "export const greeting = 'hello';\n",
  );
  assert.equal(
    decoder.decode(await workspace.readFile('src/index.ts')),
    "export const greeting = 'unselected';\n",
  );
});

test('workspace commit: selecting a rename publishes both sides of the rename', async () => {
  const adapter = new FixtureAdapter();
  const workspace = await RemotishWorkspace.open(adapter);

  await workspace.rename('README.md', 'README-renamed.md', false);
  await workspace.writeFile('src/index.ts', encoder.encode("export const greeting = 'later';\n"), {
    create: false,
    overwrite: true,
  });

  const result = await workspace.commitAndPush('Rename README only', ['README-renamed.md']);
  assert.equal(result.status, 'success');
  if (result.status !== 'success') {
    return;
  }

  await assert.rejects(adapter.readFile(result.revision, 'README.md'));
  assert.match(
    decoder.decode(await adapter.readFile(result.revision, 'README-renamed.md')),
    /Fixture repository/,
  );
  assert.deepEqual(await workspace.getChanges(), [{ type: 'modified', path: 'src/index.ts' }]);
});

test('workspace mutations: a write started during commit publication is applied after the commit', async () => {
  const baseAdapter = new FixtureAdapter();
  const gate = delayNextCall(baseAdapter, 'commit');
  const workspace = await RemotishWorkspace.open(gate.adapter);

  await workspace.writeFile('README.md', encoder.encode('published\n'), {
    create: false,
    overwrite: true,
  });

  const commit = workspace.commitAndPush('Publish README');
  await gate.started;
  const write = workspace.writeFile(
    'src/index.ts',
    encoder.encode("export const greeting = 'after commit';\n"),
    { create: false, overwrite: true },
  );

  gate.release();
  const result = await commit;
  await write;

  assert.equal(result.status, 'success');
  assert.equal(workspace.hasChanges, true);
  assert.deepEqual(await workspace.getChanges(), [{ type: 'modified', path: 'src/index.ts' }]);
  assert.equal(
    decoder.decode(await workspace.readFile('src/index.ts')),
    "export const greeting = 'after commit';\n",
  );
});

test('workspace mutations: branch switch waits for an in-flight working-tree mutation', async () => {
  const baseAdapter = new FixtureAdapter();
  const gate = delayNextCall(baseAdapter, 'readDirectory');
  const workspace = await RemotishWorkspace.open(gate.adapter);
  const events = [];
  workspace.onDidChange((event) => events.push(event));

  const write = workspace.writeFile('README.md', encoder.encode('main edit\n'), {
    create: false,
    overwrite: true,
  });
  await gate.started;
  const switchBranch = workspace.switchBranch('feature/test');

  assert.equal(workspace.branch, 'main');
  gate.release();
  await Promise.all([write, switchBranch]);

  assert.deepEqual(
    events.map((event) => event.branch),
    ['main', 'feature/test'],
  );
  await workspace.switchBranch('main');
  assert.equal(decoder.decode(await workspace.readFile('README.md')), 'main edit\n');
});

function delayNextCall(target, method) {
  const started = deferred();
  const release = deferred();
  let delayed = false;
  const adapter = new Proxy(target, {
    get(current, property, receiver) {
      if (property === method) {
        return async (...args) => {
          if (!delayed) {
            delayed = true;
            started.resolve();
            await release.promise;
          }
          return current[property](...args);
        };
      }
      const value = Reflect.get(current, property, receiver);
      return typeof value === 'function' ? value.bind(current) : value;
    },
  });
  return { adapter, started: started.promise, release: release.resolve };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('workspace commit: read-only adapters may omit the commit method entirely', async () => {
  const inner = new FixtureAdapter();
  const adapter = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'capabilities') {
        return { commits: false };
      }
      if (property === 'commit') {
        return undefined;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const workspace = await RemotishWorkspace.open(adapter);
  await assert.rejects(
    workspace.writeFile('README.md', encoder.encode('local read-only edit\n'), {
      create: false,
      overwrite: true,
    }),
    (error) => error instanceof RemotishError && error.code === 'FORBIDDEN',
  );

  await assert.rejects(
    workspace.commitAndPush('Cannot publish'),
    (error) => error instanceof RemotishError && error.code === 'UNSUPPORTED',
  );
  assert.equal(workspace.hasChanges, false);
});

test('workspace open: rejects inconsistent advertised adapter capabilities', async () => {
  const inner = new FixtureAdapter();
  const adapter = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'capabilities') {
        return { commits: false, forceWithLease: true };
      }
      return Reflect.get(target, property, receiver);
    },
  });

  await assert.rejects(
    RemotishWorkspace.open(adapter),
    (error) =>
      error instanceof RemotishError &&
      error.code === 'INVALID_REQUEST' &&
      error.message.includes('forceWithLease requires commit support'),
  );
});
