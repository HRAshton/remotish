import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import {
  REMOTISH_OPEN_REPOSITORY_COMMAND,
  REMOTISH_REPOSITORY_COMMAND_VERSION,
} from '@remotish/adapter-sdk';
import { RemotishProviderHost } from '@remotish/vscode';
import * as vscode from 'vscode';

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

function createContext() {
  return {
    workspaceState: createMemento(),
    globalState: createMemento(),
    storageUri: vscode.Uri.from({
      scheme: 'test-storage',
      authority: 'workspace',
      path: '/open-restoration',
    }),
    globalStorageUri: vscode.Uri.from({
      scheme: 'test-storage',
      authority: 'global',
      path: '/open-restoration',
    }),
    subscriptions: [],
  };
}

test('openRepository rejects providers without restoration before navigation', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());

  let adapterCreations = 0;
  vscode.__test.installExtension({
    id: 'example.fixture-provider',
    packageJSON: {
      remotish: {
        provider: true,
        apiVersion: 1,
        id: 'fixture-provider',
        displayName: 'Fixture Provider',
      },
    },
    async activate() {
      return {
        apiVersion: 1,
        id: 'fixture-provider',
        displayName: 'Fixture Provider',
        validateRepository() {},
        createAdapter() {
          adapterCreations += 1;
          return new FixtureAdapter();
        },
      };
    },
  });

  const host = new RemotishProviderHost(createContext());
  t.after(() => host.dispose());

  await assert.rejects(
    vscode.commands.executeCommand(REMOTISH_OPEN_REPOSITORY_COMMAND, {
      version: REMOTISH_REPOSITORY_COMMAND_VERSION,
      provider: 'fixture-provider',
      repository: { repository: 'demo' },
    }),
    /does not support workspace restoration/u,
  );

  assert.equal(adapterCreations, 0);
  assert.equal(
    vscode.__test.externalCommands.some((item) => item.command === 'vscode.openFolder'),
    false,
  );
});
