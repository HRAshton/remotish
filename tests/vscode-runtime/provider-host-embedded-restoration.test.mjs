import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import { REMOTISH_REPOSITORY_COMMAND_VERSION } from '@remotish/adapter-sdk';
import { RemotishProviderHost } from '@remotish/vscode';
import * as vscode from 'vscode';

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
      path: '/embedded-restoration',
    }),
    globalStorageUri: vscode.Uri.from({
      scheme: 'test-storage',
      authority: 'global',
      path: '/embedded-restoration',
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

function createProvider(records) {
  return {
    apiVersion: 1,
    id: 'embedded-provider',
    displayName: 'Embedded Provider',
    validateRepository(repository) {
      assert.equal(repository.repository, 'demo');
    },
    createAdapter() {
      return new FixtureAdapter();
    },
    async restoreWorkspace(workspaceId) {
      return records.get(workspaceId);
    },
  };
}

test('programmatically registered providers participate in cold restoration', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());

  const globalState = createMemento();
  const records = new Map();
  const command = {
    version: REMOTISH_REPOSITORY_COMMAND_VERSION,
    provider: 'embedded-provider',
    repository: { repository: 'demo' },
  };

  const firstHost = new RemotishProviderHost(createContext(globalState));
  const firstRegistration = firstHost.registerProvider(
    createProvider(records),
    'example.embedded-provider',
  );
  const prepared = await firstHost.ensureRepository(command);
  records.set(prepared.workspaceId, {
    provider: 'embedded-provider',
    repository: { repository: 'demo' },
  });

  const firstFileSystem = vscode.__test.fileSystemProviders.get('remotish').provider;
  await firstFileSystem.writeFile(
    workingUri(prepared.workspaceId),
    new TextEncoder().encode('embedded overlay\n'),
    { create: false, overwrite: true },
  );
  firstRegistration.dispose();
  firstHost.dispose();

  vscode.__test.reset({ preserveStorage: true });
  const secondHost = new RemotishProviderHost(createContext(globalState));
  const secondRegistration = secondHost.registerProvider(
    createProvider(records),
    'example.embedded-provider',
  );
  t.after(() => {
    secondRegistration.dispose();
    secondHost.dispose();
  });

  const secondFileSystem = vscode.__test.fileSystemProviders.get('remotish').provider;
  const content = await secondFileSystem.readFile(workingUri(prepared.workspaceId));
  assert.equal(new TextDecoder().decode(content), 'embedded overlay\n');
});
