import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RemotishProviderHost } from '@remotish/vscode';
import * as vscode from 'vscode';

import { FIXTURE_REQUEST, installFixtureProvider } from './fixture-provider-extension.mjs';

function createMemento(values = new Map()) {
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

function createContext(globalState) {
  return {
    workspaceState: createMemento(),
    globalState,
    storageUri: vscode.Uri.from({
      scheme: 'test-storage',
      authority: 'workspace',
      path: '/discovered-restoration',
    }),
    globalStorageUri: vscode.Uri.from({
      scheme: 'test-storage',
      authority: 'global',
      path: '/discovered-restoration',
    }),
    subscriptions: [],
  };
}

function workingUri(workspaceId) {
  return vscode.Uri.from({
    scheme: 'remotish',
    authority: workspaceId,
    path: '/README.md',
  });
}

test('discovered fixture provider restores a canonical workspace after a cold host start', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());

  const globalState = createMemento();
  const firstProvider = installFixtureProvider();
  const firstHost = new RemotishProviderHost(createContext(globalState));
  const prepared = await firstHost.ensureRepository(FIXTURE_REQUEST);
  assert.equal(firstProvider.extension.isActive, true);

  const firstFileSystem = vscode.__test.fileSystemProviders.get('remotish').provider;
  await firstFileSystem.writeFile(
    workingUri(prepared.workspaceId),
    new TextEncoder().encode('discovered overlay\n'),
    { create: false, overwrite: true },
  );
  firstHost.dispose();
  firstProvider.dispose();

  vscode.__test.reset({ preserveStorage: true });
  const secondProvider = installFixtureProvider();
  const secondHost = new RemotishProviderHost(createContext(globalState));
  t.after(() => {
    secondHost.dispose();
    secondProvider.dispose();
  });

  assert.equal(secondProvider.extension.isActive, false);
  const secondFileSystem = vscode.__test.fileSystemProviders.get('remotish').provider;
  const content = await secondFileSystem.readFile(workingUri(prepared.workspaceId));
  assert.equal(new TextDecoder().decode(content), 'discovered overlay\n');
  assert.equal(secondProvider.extension.isActive, true);
});
