import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import { REMOTISH_REPOSITORY_COMMAND_VERSION } from '@remotish/adapter-sdk';
import { createStableWorkspaceId, RemotishProviderHost } from '@remotish/vscode';
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
      path: '/restore-identity',
    }),
    globalStorageUri: vscode.Uri.from({
      scheme: 'test-storage',
      authority: 'global',
      path: '/restore-identity',
    }),
    subscriptions: [],
  };
}

function request(repository = 'demo') {
  return {
    version: REMOTISH_REPOSITORY_COMMAND_VERSION,
    provider: 'fixture-provider',
    repository: { repository },
  };
}

function workingUri(workspaceId) {
  return vscode.Uri.from({
    scheme: 'remotish',
    authority: workspaceId,
    path: '/README.md',
  });
}

class WrongIdentityAdapter extends FixtureAdapter {
  async getRepository(options) {
    const repository = await super.getRepository(options);
    return { ...repository, id: 'fixture/wrong' };
  }
}

function installProvider(records) {
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
        validateRepository(repository) {
          assert.equal(typeof repository.repository, 'string');
        },
        createAdapter(repository) {
          return repository.repository === 'wrong'
            ? new WrongIdentityAdapter()
            : new FixtureAdapter();
        },
        async restoreWorkspace(workspaceId) {
          return records.get(workspaceId);
        },
      };
    },
  });
}

test('restoration identity mismatch fails before registering the wrong repository', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());

  const globalState = createMemento();
  const records = new Map();
  installProvider(records);

  const firstHost = new RemotishProviderHost(createContext(globalState));
  const prepared = await firstHost.ensureRepository(request());
  records.set(prepared.workspaceId, {
    provider: 'fixture-provider',
    repository: { repository: 'wrong' },
    branch: 'feature/test',
  });
  firstHost.dispose();

  vscode.__test.reset({ preserveStorage: true });
  installProvider(records);
  const secondHost = new RemotishProviderHost(createContext(globalState));
  t.after(() => secondHost.dispose());

  const wrongWorkspaceId = await createStableWorkspaceId('fixture-provider', 'fixture/wrong');
  const fileSystem = vscode.__test.fileSystemProviders.get('remotish').provider;
  await assert.rejects(
    fileSystem.readFile(workingUri(prepared.workspaceId)),
    (error) =>
      error?.code === 'Unavailable' &&
      /Repository identity does not match restored workspace/u.test(error.message),
  );
  assert.equal(secondHost.host.registry.get(wrongWorkspaceId), undefined);
});

test('restoration identity checks are isolated from concurrent normal preparation', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());

  const globalState = createMemento();
  const records = new Map();
  installProvider(records);

  const firstHost = new RemotishProviderHost(createContext(globalState));
  const prepared = await firstHost.ensureRepository(request());
  records.set(prepared.workspaceId, {
    provider: 'fixture-provider',
    repository: { repository: 'wrong' },
  });
  firstHost.dispose();

  vscode.__test.reset({ preserveStorage: true });
  let creations = 0;
  let started;
  const firstStarted = new Promise((resolve) => {
    started = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
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
        validateRepository(repository) {
          assert.equal(typeof repository.repository, 'string');
        },
        async createAdapter(repository) {
          creations += 1;
          if (creations === 1) {
            started();
          }
          await gate;
          return repository.repository === 'wrong'
            ? new WrongIdentityAdapter()
            : new FixtureAdapter();
        },
        async restoreWorkspace(workspaceId) {
          return records.get(workspaceId);
        },
      };
    },
  });

  const secondHost = new RemotishProviderHost(createContext(globalState));
  t.after(() => secondHost.dispose());

  const normalPreparation = secondHost.ensureRepository(request('wrong'));
  await firstStarted;
  const fileSystem = vscode.__test.fileSystemProviders.get('remotish').provider;
  const restoration = assert.rejects(
    fileSystem.readFile(workingUri(prepared.workspaceId)),
    (error) =>
      error?.code === 'Unavailable' &&
      /Repository identity does not match restored workspace/u.test(error.message),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const concurrentCreations = creations;
  release();

  const normalResult = await normalPreparation;
  const wrongWorkspaceId = await createStableWorkspaceId('fixture-provider', 'fixture/wrong');
  assert.equal(normalResult.workspaceId, wrongWorkspaceId);
  await restoration;
  assert.equal(
    concurrentCreations,
    2,
    'restoration must not share preparation that lacks its expected workspace identity',
  );
});
