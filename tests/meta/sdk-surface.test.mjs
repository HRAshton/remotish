import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sdkIndex = await readFile(
  new URL('../../packages/adapter-sdk/src/index.ts', import.meta.url),
  'utf8',
);
const sdkManifest = JSON.parse(
  await readFile(new URL('../../packages/adapter-sdk/package.json', import.meta.url)),
);

test('adapter SDK root is an explicit API surface rather than a wildcard barrel', () => {
  assert.doesNotMatch(sdkIndex, /export\s+\*/u);
  assert.deepEqual(Object.keys(sdkManifest.exports ?? {}), ['.']);
});

test('reference adapters depend on the public adapter SDK, not framework internals', async () => {
  for (const path of [
    '../../adapters/github/package.json',
    '../../adapters/http-example/package.json',
    '../../adapters/rpc/package.json',
    '../../packages/adapter-fixture/package.json',
  ]) {
    const manifest = JSON.parse(await readFile(new URL(path, import.meta.url)));
    const internalDependencies = Object.keys(manifest.dependencies ?? {}).filter((name) =>
      name.startsWith('@remotish/'),
    );
    assert.deepEqual(internalDependencies, ['@remotish/adapter-sdk'], path);
  }
});
