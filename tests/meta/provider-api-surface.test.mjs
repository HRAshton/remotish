import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(
  new URL('../../packages/vscode/src/provider-api.ts', import.meta.url),
  'utf8',
);
const manifest = JSON.parse(
  await readFile(new URL('../../packages/vscode/package.json', import.meta.url)),
);

test('provider API is versioned and isolated from core and VS Code runtime types', () => {
  assert.match(source, /REMOTISH_EXTENSION_API_VERSION = 1 as const/u);
  assert.match(source, /from '@remotish\/adapter-sdk'/u);
  assert.doesNotMatch(source, /@remotish\/core/u);
  assert.doesNotMatch(source, /from 'vscode'/u);
});

test('provider API has a dedicated package subpath', () => {
  assert.deepEqual(manifest.exports?.['./provider-api'], {
    types: './dist/provider-api.d.ts',
    default: './dist/provider-api.js',
  });
});
