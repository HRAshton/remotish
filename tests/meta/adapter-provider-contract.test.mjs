import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const providerSource = await readFile(
  new URL('../../packages/adapter-sdk/src/provider.ts', import.meta.url),
  'utf8',
);
const sdkSource = await readFile(
  new URL('../../packages/adapter-sdk/src/index.ts', import.meta.url),
  'utf8',
);

test('adapter SDK owns the versioned provider compatibility surface', () => {
  assert.match(providerSource, /REMOTISH_ADAPTER_PROVIDER_API_VERSION = 1 as const/u);
  assert.match(providerSource, /REMOTISH_REPOSITORY_COMMAND_VERSION = 1 as const/u);
  assert.match(providerSource, /interface RemotishAdapterProviderV1/u);
  assert.match(providerSource, /restoreWorkspace\?/u);
  assert.match(providerSource, /interface RemotishRepositoryCommandV1/u);
  assert.match(providerSource, /interface RemotishRepositoryResultV1/u);
  assert.match(sdkSource, /from '\.\/provider\.js'/u);
});

test('provider contract remains independent from VS Code and Remotish implementation packages', () => {
  for (const forbidden of [
    /from 'vscode'/u,
    /@remotish\/core/u,
    /@remotish\/vscode/u,
    /ExtensionContext/u,
    /RemotishWorkspace/u,
    /RemotishVsCodeHost/u,
  ]) {
    assert.doesNotMatch(providerSource, forbidden);
  }
});
