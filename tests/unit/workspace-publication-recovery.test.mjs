import assert from 'node:assert/strict';
import test from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import { RemotishWorkspace } from '@remotish/core';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test('workspace commit: restart reconciles a published change after snapshot persistence fails', async () => {
  const adapter = new FixtureAdapter();
  const storage = failingStorage(3);
  const workspace = await RemotishWorkspace.open(adapter, storage);

  await workspace.writeFile('README.md', encoder.encode('published\n'), {
    create: false,
    overwrite: true,
  });

  const result = await workspace.commitAndPush('Publish README');
  assert.equal(result.status, 'success');
  if (result.status !== 'success') {
    return;
  }
  assert.equal(workspace.baseRevision, result.revision);
  assert.equal(workspace.hasChanges, false);

  const restored = await RemotishWorkspace.open(adapter, storage);
  assert.equal(restored.baseRevision, result.revision);
  assert.equal(restored.hasChanges, false);
  assert.equal(decoder.decode(await restored.readFile('README.md')), 'published\n');
});

test('workspace commit: recovery preserves changes omitted from a partial publication', async () => {
  const adapter = new FixtureAdapter();
  const storage = failingStorage(4);
  const workspace = await RemotishWorkspace.open(adapter, storage);

  await workspace.writeFile('README.md', encoder.encode('published\n'), {
    create: false,
    overwrite: true,
  });
  await workspace.writeFile(
    'src/index.ts',
    encoder.encode("export const greeting = 'still local';\n"),
    { create: false, overwrite: true },
  );

  const result = await workspace.commitAndPush('Publish README only', ['README.md']);
  assert.equal(result.status, 'success');
  if (result.status !== 'success') {
    return;
  }

  const restored = await RemotishWorkspace.open(adapter, storage);
  assert.equal(restored.baseRevision, result.revision);
  assert.deepEqual(await restored.getChanges(), [{ type: 'modified', path: 'src/index.ts' }]);
  assert.equal(decoder.decode(await restored.readFile('README.md')), 'published\n');
  assert.equal(
    decoder.decode(await restored.readFile('src/index.ts')),
    "export const greeting = 'still local';\n",
  );
});

test('workspace commit: journal persistence must succeed before publication starts', async () => {
  const adapter = new FixtureAdapter();
  const storage = failingStorage(2);
  const workspace = await RemotishWorkspace.open(adapter, storage);

  await workspace.writeFile('README.md', encoder.encode('local\n'), {
    create: false,
    overwrite: true,
  });

  await assert.rejects(workspace.commitAndPush('Must not publish'), /disk full/u);
  assert.equal(adapter.getBranchHead('main'), 'C3');
  assert.equal(workspace.baseRevision, 'C3');
  assert.equal(workspace.hasChanges, true);
});

function failingStorage(failAtSave) {
  let snapshot;
  let saves = 0;
  return {
    async load() {
      return snapshot === undefined ? undefined : structuredClone(snapshot);
    },
    async save(_repositoryId, next) {
      saves += 1;
      if (saves === failAtSave) {
        throw new Error('disk full');
      }
      snapshot = structuredClone(next);
    },
    async delete() {
      snapshot = undefined;
    },
  };
}
