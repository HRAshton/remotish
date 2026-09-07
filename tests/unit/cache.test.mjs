import assert from 'node:assert/strict';
import test from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import { RepositoryReader, RevisionCache } from '@remotish/core';

test('revision cache: immutable file and directory reads are reused', async () => {
  const inner = new FixtureAdapter();
  let fileReads = 0;
  let directoryReads = 0;
  const adapter = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'readFile') {
        return async (...args) => {
          fileReads += 1;
          return target.readFile(...args);
        };
      }
      if (property === 'readDirectory') {
        return async (...args) => {
          directoryReads += 1;
          return target.readDirectory(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const reader = new RepositoryReader(adapter);
  await reader.readFile('C3', 'README.md');
  await reader.readFile('C3', 'README.md');
  await reader.readDirectory('C3', 'src');
  await reader.readDirectory('C3', 'src');

  assert.equal(fileReads, 1);
  assert.equal(directoryReads, 1);
});

test('revision cache: LRU eviction keeps the cache inside its byte budget', () => {
  const cache = new RevisionCache({ maxBytes: 420 });
  const content = new Uint8Array(100);

  cache.setFile('R1', 'a.txt', content);
  cache.setFile('R1', 'b.txt', content);
  assert.ok(cache.sizeBytes <= 420);
  assert.ok(cache.getFile('R1', 'a.txt'));

  // Touching a.txt makes b.txt the least-recently-used entry.
  cache.setFile('R1', 'c.txt', content);
  assert.ok(cache.sizeBytes <= 420);
  assert.ok(cache.getFile('R1', 'a.txt'));
  assert.equal(cache.getFile('R1', 'b.txt'), undefined);
  assert.ok(cache.getFile('R1', 'c.txt'));
});

test('revision cache: concurrent identical reads are coalesced at the adapter boundary', async () => {
  const inner = new FixtureAdapter();
  let fileReads = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const adapter = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'readFile') {
        return async (...args) => {
          fileReads += 1;
          await gate;
          return target.readFile(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const reader = new RepositoryReader(adapter);
  const first = reader.readFile('C3', 'README.md');
  const second = reader.readFile('C3', 'README.md');
  await Promise.resolve();
  assert.equal(fileReads, 1);
  release();
  const [firstContent, secondContent] = await Promise.all([first, second]);
  assert.deepEqual(firstContent, secondContent);
  assert.equal(fileReads, 1);
});
