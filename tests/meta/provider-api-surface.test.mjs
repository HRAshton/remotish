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
  assert.match(source, /REMOTISH_WORKSPACE_ID_FORMAT_VERSION = 1 as const/u);
  assert.match(source, /ensureRepository\(/u);
  assert.match(source, /openRepository\(/u);
  assert.match(source, /from '@remotish\/adapter-sdk'/u);
  assert.doesNotMatch(source, /@remotish\/core/u);
  assert.doesNotMatch(source, /from 'vscode'/u);
});

test('serialized provider requests and reconstruction records are explicitly versioned', () => {
  assert.match(source, /interface SerializedRemotishOpenRequestV1/u);
  assert.match(source, /readonly version: 1;/u);
  assert.match(source, /interface PersistedProviderWorkspaceV1/u);
});

test('provider API has a dedicated lightweight package subpath', () => {
  assert.deepEqual(manifest.exports?.['./provider-api'], {
    types: './dist/provider-api.d.ts',
    default: './dist/provider-api.js',
  });
  assert.equal(manifest.publishConfig?.access, 'public');
});
