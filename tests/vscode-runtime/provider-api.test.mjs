import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import * as vscode from 'vscode';

import { activate } from '../../apps/demo-web/build/extension.js';

function createMemento() {
  const values = new Map();
  return {
    get(key, defaultValue) {
      return values.has(key) ? values.get(key) : defaultValue;
    },
    async update(key, value) {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    },
  };
}

async function activateHost(t) {
  vscode.__test.reset();
  const context = {
    workspaceState: createMemento(),
    globalState: createMemento(),
    storageUri: vscode.Uri.from({
      scheme: 'test-storage',
      authority: 'workspace',
      path: '/provider-api',
    }),
    globalStorageUri: vscode.Uri.from({
      scheme: 'test-storage',
      authority: 'global',
      path: '/provider-api',
    }),
    subscriptions: [],
  };
  const api = await activate(context);
  t.after(() => {
    for (const disposable of [...context.subscriptions].reverse()) {
      disposable.dispose();
    }
    vscode.__test.reset();
  });
  return { api, context };
}

function fixtureProvider(createAdapter) {
  return {
    id: 'fixture-provider',
    displayName: 'Fixture Provider',
    extensionId: 'example.fixture-provider',
    validateRepository(repository) {
      assert.deepEqual(Object.keys(repository), ['repository']);
      assert.equal(repository.repository, 'demo');
    },
    createAdapter,
  };
}

test('provider API: ensureRepository prepares without navigation and coalesces concurrency', async (t) => {
  const { api } = await activateHost(t);
  let adapterCreations = 0;
  api.registerProvider(
    fixtureProvider(async () => {
      adapterCreations += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new FixtureAdapter();
    }),
  );

  const request = {
    provider: 'fixture-provider',
    repository: { repository: 'demo' },
    branch: 'feature/test',
  };
  const [first, second] = await Promise.all([
    api.ensureRepository(request),
    api.ensureRepository(request),
  ]);

  assert.equal(adapterCreations, 1);
  assert.deepEqual(first, second);
  assert.equal(first.branch, 'feature/test');
  assert.match(first.uri, /^remotish:\/\/fixture-provider-[a-f0-9]{32}\/$/u);
  assert.equal(
    vscode.__test.externalCommands.some((item) => item.command === 'vscode.openFolder'),
    false,
  );

  const before = vscode.__test.sourceControls.length;
  await api.ensureRepository(request);
  assert.equal(vscode.__test.sourceControls.length, before);
});

test('provider API: openRepository delegates preparation then opens the canonical root', async (t) => {
  const { api } = await activateHost(t);
  api.registerProvider(fixtureProvider(() => new FixtureAdapter()));

  const result = await api.openRepository({
    provider: 'fixture-provider',
    repository: { repository: 'demo' },
    path: 'README.md',
  });

  assert.equal(result.uri.endsWith('/'), true);
  assert.equal(result.resourceUri?.endsWith('/README.md'), true);
  const open = vscode.__test.externalCommands.find((item) => item.command === 'vscode.openFolder');
  assert.equal(open?.args[0].toString(), result.uri);
});

test('provider API: restoration verifies the persisted canonical workspace identity', async (t) => {
  const { api } = await activateHost(t);
  api.registerProvider(fixtureProvider(() => new FixtureAdapter()));

  await assert.rejects(
    () =>
      api.ensureRepository({
        provider: 'fixture-provider',
        repository: { repository: 'demo' },
        expectedWorkspaceId: 'fixture-provider-00000000000000000000000000000000',
      }),
    /does not match restored workspace/u,
  );
});
