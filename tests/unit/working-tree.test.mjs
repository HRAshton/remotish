import assert from 'node:assert/strict';
import test from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import { RepositoryReader, WorkingTree } from '@remotish/core';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test('working tree: modify/add/delete/revert without moving the base', async () => {
  const adapter = new FixtureAdapter();
  const tree = new WorkingTree(new RepositoryReader(adapter), 'C3');

  await tree.writeFile('README.md', encoder.encode('changed\n'), {
    create: false,
    overwrite: true,
  });
  await tree.writeFile('src/new.ts', encoder.encode('export const value = 1;\n'), {
    create: true,
    overwrite: false,
  });
  await tree.delete('src/util.ts', false);

  assert.equal(tree.baseRevision, 'C3');
  assert.deepEqual(await tree.getChanges(), [
    { type: 'modified', path: 'README.md' },
    { type: 'added', path: 'src/new.ts' },
    { type: 'deleted', path: 'src/util.ts' },
  ]);

  await tree.revert('README.md');
  assert.match(decoder.decode(await tree.readFile('README.md')), /Main branch/);
  await tree.revert('src/new.ts');
  await tree.revert('src/util.ts');
  assert.equal(tree.hasChanges, false);
});

test('working tree: no-op write equal to base does not create a change', async () => {
  const adapter = new FixtureAdapter();
  const tree = new WorkingTree(new RepositoryReader(adapter), 'C3');
  const base = await tree.readBaseFile('README.md');
  await tree.writeFile('README.md', base, { create: false, overwrite: true });
  assert.deepEqual(await tree.getChanges(), []);
});

test('working tree: directory rename becomes file-level renames and can be partially reverted', async () => {
  const adapter = new FixtureAdapter();
  const tree = new WorkingTree(new RepositoryReader(adapter), 'C3');

  await tree.rename('src', 'lib', false);
  assert.deepEqual(await tree.getChanges(), [
    { type: 'renamed', path: 'lib/index.ts', originalPath: 'src/index.ts' },
    { type: 'renamed', path: 'lib/util.ts', originalPath: 'src/util.ts' },
  ]);

  const commitChanges = await tree.buildCommitChanges();
  assert.deepEqual(
    commitChanges.map((change) => [change.type, change.path]),
    [
      ['add', 'lib/index.ts'],
      ['add', 'lib/util.ts'],
      ['delete', 'src/index.ts'],
      ['delete', 'src/util.ts'],
    ],
  );

  await tree.revert('lib/index.ts');
  assert.equal(
    decoder.decode(await tree.readFile('src/index.ts')),
    "export const greeting = 'hello';\n",
  );
  await assert.rejects(() => tree.readFile('src/util.ts'), /does not exist/);
  assert.deepEqual(await tree.getChanges(), [
    { type: 'renamed', path: 'lib/util.ts', originalPath: 'src/util.ts' },
  ]);
});

test('working tree: remote branch movement never mutates the immutable base', async () => {
  const adapter = new FixtureAdapter();
  const tree = new WorkingTree(new RepositoryReader(adapter), 'C3');
  adapter.moveBranchHead('main', 'F2');

  assert.equal(tree.baseRevision, 'C3');
  assert.match(decoder.decode(await tree.readFile('README.md')), /Main branch/);
});

test('working tree: adapter child paths cannot escape recursive delete or rename subtrees', async () => {
  class MalformedPathAdapter extends FixtureAdapter {
    async readDirectory(revision, path, options) {
      const entries = await super.readDirectory(revision, path, options);
      if (path !== 'src') {
        return entries;
      }
      return entries.map((entry) =>
        entry.name === 'util.ts' ? { ...entry, path: 'README.md' } : entry,
      );
    }
  }

  const deleteTree = new WorkingTree(new RepositoryReader(new MalformedPathAdapter()), 'C3');
  const readmeBeforeDelete = await deleteTree.readFile('README.md');
  await deleteTree.delete('src', true);
  assert.deepEqual(await deleteTree.readFile('README.md'), readmeBeforeDelete);
  await assert.rejects(() => deleteTree.readFile('src/util.ts'), /does not exist/u);

  const renameTree = new WorkingTree(new RepositoryReader(new MalformedPathAdapter()), 'C3');
  const readmeBeforeRename = await renameTree.readFile('README.md');
  await renameTree.rename('src', 'lib', false);
  assert.deepEqual(await renameTree.readFile('README.md'), readmeBeforeRename);
  assert.equal(
    decoder.decode(await renameTree.readFile('lib/util.ts')),
    'export const twice = (value: number) => value * 2;\n',
  );
});

test('repository reader: rejects duplicate child names and malformed sizes from adapters', async () => {
  class DuplicateAdapter extends FixtureAdapter {
    async readDirectory(revision, path, options) {
      const entries = await super.readDirectory(revision, path, options);
      if (path === '') {
        return [entries[0], { ...entries[0] }];
      }
      return entries;
    }
  }

  await assert.rejects(
    () => new RepositoryReader(new DuplicateAdapter()).readDirectory('C3', ''),
    /duplicates child name/u,
  );

  class BadSizeAdapter extends FixtureAdapter {
    async readDirectory(revision, path, options) {
      const entries = await super.readDirectory(revision, path, options);
      if (path === '') {
        return entries.map((entry, index) => (index === 0 ? { ...entry, size: -1 } : entry));
      }
      return entries;
    }
  }

  await assert.rejects(
    () => new RepositoryReader(new BadSizeAdapter()).readDirectory('C3', ''),
    /size must be a non-negative safe integer/u,
  );
});

test('repository reader: recursive traversal stops at the depth budget', async () => {
  class DeepAdapter extends FixtureAdapter {
    async readDirectory(revision, path, options) {
      if (path === '') {
        return super.readDirectory(revision, path, options);
      }
      if (path === 'src' || path.startsWith('src/')) {
        return [{ name: 'loop', path: 'README.md', type: 'directory' }];
      }
      return super.readDirectory(revision, path, options);
    }
  }

  await assert.rejects(
    () => new RepositoryReader(new DeepAdapter()).listFilesRecursively('C3', 'src'),
    /maximum depth/u,
  );
});

test('repository reader: adapter reads are bounded even when cancellation is ignored', async () => {
  class HangingAdapter extends FixtureAdapter {
    async readDirectory(_revision, _path, _options) {
      return new Promise(() => {});
    }
  }

  const reader = new RepositoryReader(new HangingAdapter(), undefined, { requestTimeoutMs: 5 });
  await assert.rejects(
    () => reader.readDirectory('C3', ''),
    (error) => error?.code === 'OFFLINE' && /timed out/u.test(String(error.message)),
  );
});
