import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import {
  REMOTISH_ENSURE_REPOSITORY_COMMAND,
  REMOTISH_OPEN_REPOSITORY_COMMAND,
  REMOTISH_REPOSITORY_COMMAND_VERSION,
} from '@remotish/adapter-sdk';
import * as vscode from 'vscode';

import { activate } from '../../apps/demo-web/build/extension.js';

function createMemento(values = new Map()) {
  return {
    values,
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

function createContext({ globalState = createMemento(), root = '/provider-discovery' } = {}) {
  return {
    workspaceState: createMemento(),
    globalState,
    storageUri: vscode.Uri.from({
      scheme: 'test-storage',
      authority: 'workspace',
      path: root,
    }),
    globalStorageUri: vscode.Uri.from({
      scheme: 'test-storage',
      authority: 'global',
      path: root,
    }),
    subscriptions: [],
  };
}

function disposeContext(context) {
  for (const disposable of [...context.subscriptions].reverse()) {
    disposable.dispose();
  }
}

function installFixtureProvider({
  extensionId = 'example.fixture-provider',
  providerId = 'fixture-provider',
  displayName = 'Fixture Provider',
  activations = { count: 0 },
  adapterCreations = { count: 0 },
  records = new Map(),
  restoreFailure,
  validateRepository,
} = {}) {
  return vscode.__test.installExtension({
    id: extensionId,
    packageJSON: {
      remotish: {
        provider: true,
        apiVersion: 1,
        id: providerId,
        displayName,
      },
    },
    async activate() {
      activations.count += 1;
      return {
        apiVersion: 1,
        id: providerId,
        displayName,
        validateRepository(repository) {
          if (validateRepository) {
            validateRepository(repository);
            return;
          }
          assert.deepEqual(Object.keys(repository), ['repository']);
          assert.equal(repository.repository, 'demo');
        },
        createAdapter() {
          adapterCreations.count += 1;
          return new FixtureAdapter();
        },
        async restoreWorkspace(workspaceId) {
          if (restoreFailure?.error) {
            throw restoreFailure.error;
          }
          return records.get(workspaceId);
        },
      };
    },
  });
}

function request(overrides = {}) {
  return {
    version: REMOTISH_REPOSITORY_COMMAND_VERSION,
    provider: 'fixture-provider',
    repository: { repository: 'demo' },
    ...overrides,
  };
}

function workingUri(workspaceId, path = '/') {
  return vscode.Uri.from({
    scheme: 'remotish',
    authority: workspaceId,
    path,
  });
}

test('provider discovery inspects manifests without activating providers', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());

  const first = { count: 0 };
  const second = { count: 0 };
  installFixtureProvider({ activations: first });
  installFixtureProvider({
    extensionId: 'example.other-provider',
    providerId: 'other-provider',
    displayName: 'Other Provider',
    activations: second,
  });

  const context = createContext();
  await activate(context);
  t.after(() => disposeContext(context));

  assert.equal(first.count, 0);
  assert.equal(second.count, 0);
});

test('opening one repository lazily activates only its provider and opens the canonical root', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());

  const first = { count: 0 };
  const second = { count: 0 };
  installFixtureProvider({ activations: first });
  installFixtureProvider({
    extensionId: 'example.other-provider',
    providerId: 'other-provider',
    displayName: 'Other Provider',
    activations: second,
  });

  const context = createContext();
  await activate(context);
  t.after(() => disposeContext(context));

  const result = await vscode.commands.executeCommand(
    REMOTISH_OPEN_REPOSITORY_COMMAND,
    request({ path: 'README.md' }),
  );

  assert.equal(result.version, 1);
  assert.equal(first.count, 1);
  assert.equal(second.count, 0);
  assert.equal(result.resourceUri.endsWith('/README.md'), true);
  const opened = vscode.__test.externalCommands.find(
    (item) => item.command === 'vscode.openFolder',
  );
  assert.equal(opened?.args[0].toString(), result.uri);
  assert.equal(result.uri.endsWith('/'), true);
});

test('provider activation export is validated before repository access', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());

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
      };
    },
  });

  const context = createContext();
  await activate(context);
  t.after(() => disposeContext(context));

  await assert.rejects(
    vscode.commands.executeCommand(REMOTISH_ENSURE_REPOSITORY_COMMAND, request()),
    /malformed: activation result requires createAdapter\(\)/u,
  );
});

test('duplicate provider ids fail deterministically without activating either extension', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());

  const first = { count: 0 };
  const second = { count: 0 };
  installFixtureProvider({ extensionId: 'example.first-provider', activations: first });
  installFixtureProvider({ extensionId: 'example.second-provider', activations: second });

  const context = createContext();
  await assert.rejects(
    activate(context),
    /Provider id fixture-provider is claimed by both example\.first-provider and example\.second-provider/u,
  );
  assert.equal(first.count, 0);
  assert.equal(second.count, 0);
  assert.equal(vscode.__test.fileSystemProviders.size, 0);
  assert.equal(vscode.__test.sourceControls.length, 0);
});

test('concurrent identical preparation coalesces adapter work and keeps caller-specific paths', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());

  let creations = 0;
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
          assert.equal(repository.repository, 'demo');
        },
        async createAdapter() {
          creations += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return new FixtureAdapter();
        },
      };
    },
  });

  const context = createContext();
  await activate(context);
  t.after(() => disposeContext(context));

  const [readme, source] = await Promise.all([
    vscode.commands.executeCommand(
      REMOTISH_ENSURE_REPOSITORY_COMMAND,
      request({ branch: 'feature/test', path: 'README.md' }),
    ),
    vscode.commands.executeCommand(
      REMOTISH_ENSURE_REPOSITORY_COMMAND,
      request({ branch: 'feature/test', path: 'src/index.ts' }),
    ),
  ]);

  assert.equal(creations, 1);
  assert.equal(readme.workspaceId, source.workspaceId);
  assert.equal(readme.resourceUri.endsWith('/README.md'), true);
  assert.equal(source.resourceUri.endsWith('/src/index.ts'), true);
  assert.equal(readme.branch, 'feature/test');
  assert.equal(source.branch, 'feature/test');
  assert.equal(vscode.__test.sourceControls.length, 2, 'demo + one canonical provider workspace');
});

test('concurrent alias descriptors serialize before opening canonical persisted state', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());

  let branchReads = 0;
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
          assert.match(repository.repository, /^alias-(?:a|b)$/u);
        },
        createAdapter() {
          const target = new FixtureAdapter();
          return new Proxy(target, {
            get(current, property, receiver) {
              if (property === 'getBranches') {
                return async (...args) => {
                  branchReads += 1;
                  await new Promise((resolve) => setTimeout(resolve, 10));
                  return current.getBranches(...args);
                };
              }
              const value = Reflect.get(current, property, receiver);
              return typeof value === 'function' ? value.bind(current) : value;
            },
          });
        },
      };
    },
  });

  const context = createContext({ root: '/canonical-aliases' });
  await activate(context);
  t.after(() => disposeContext(context));

  const [first, second] = await Promise.all([
    vscode.commands.executeCommand(
      REMOTISH_ENSURE_REPOSITORY_COMMAND,
      request({ repository: { repository: 'alias-a' } }),
    ),
    vscode.commands.executeCommand(
      REMOTISH_ENSURE_REPOSITORY_COMMAND,
      request({ repository: { repository: 'alias-b' } }),
    ),
  ]);

  assert.equal(first.workspaceId, second.workspaceId);
  assert.equal(branchReads, 1);
  assert.equal(vscode.__test.sourceControls.length, 2, 'demo + one canonical provider workspace');
});

test('provider-owned descriptor validation is not bypassed by concurrent normalization', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());

  installFixtureProvider({
    validateRepository(repository) {
      assert.deepEqual(repository, { repository: 'demo' });
    },
  });
  const context = createContext();
  await activate(context);
  t.after(() => disposeContext(context));

  const valid = vscode.commands.executeCommand(REMOTISH_ENSURE_REPOSITORY_COMMAND, request());
  await assert.rejects(
    vscode.commands.executeCommand(
      REMOTISH_ENSURE_REPOSITORY_COMMAND,
      request({ repository: { repository: ' demo ' } }),
    ),
    /Expected values to be strictly deep-equal/u,
  );
  await valid;
});

test('routing metadata failure does not publish a canonical workspace', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());

  installFixtureProvider();
  const globalState = createMemento();
  const update = globalState.update.bind(globalState);
  globalState.update = async (key, value) => {
    if (key.startsWith('remotish.restore.v1.')) {
      throw new Error('memento unavailable');
    }
    await update(key, value);
  };

  const context = createContext({ globalState, root: '/metadata-failure' });
  await activate(context);
  t.after(() => disposeContext(context));

  await assert.rejects(
    vscode.commands.executeCommand(REMOTISH_ENSURE_REPOSITORY_COMMAND, request()),
    /memento unavailable/u,
  );
  assert.equal(vscode.__test.sourceControls.length, 1, 'only the bundled demo is registered');
});

test('canonical reload lazily restores provider state and preserves local overlay', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());

  const globalState = createMemento();
  const records = new Map();
  const firstActivations = { count: 0 };
  installFixtureProvider({ records, activations: firstActivations });

  const firstContext = createContext({ globalState });
  await activate(firstContext);
  const prepared = await vscode.commands.executeCommand(
    REMOTISH_ENSURE_REPOSITORY_COMMAND,
    request({ branch: 'feature/test' }),
  );
  records.set(prepared.workspaceId, {
    provider: 'fixture-provider',
    repository: { repository: 'demo' },
    branch: 'main',
  });

  const firstFs = vscode.__test.fileSystemProviders.get('remotish').provider;
  await firstFs.writeFile(
    workingUri(prepared.workspaceId, '/README.md'),
    new TextEncoder().encode('persisted overlay\n'),
    { create: false, overwrite: true },
  );
  disposeContext(firstContext);

  vscode.__test.reset({ preserveStorage: true });
  const secondActivations = { count: 0 };
  installFixtureProvider({ records, activations: secondActivations });
  const secondContext = createContext({ globalState });
  await activate(secondContext);
  t.after(() => disposeContext(secondContext));

  assert.equal(secondActivations.count, 0);
  const secondFs = vscode.__test.fileSystemProviders.get('remotish').provider;
  const content = await secondFs.readFile(workingUri(prepared.workspaceId, '/README.md'));
  assert.equal(new TextDecoder().decode(content), 'persisted overlay\n');
  const branchContent = await secondFs.readFile(workingUri(prepared.workspaceId, '/src/index.ts'));
  assert.equal(new TextDecoder().decode(branchContent), "export const greeting = 'feature';\n");
  assert.equal(secondActivations.count, 1);
});

test('provider missing on reload preserves overlay and permits retry after installation', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());

  const globalState = createMemento();
  const records = new Map();
  installFixtureProvider({ records });
  const firstContext = createContext({ globalState, root: '/missing-retry' });
  await activate(firstContext);
  const prepared = await vscode.commands.executeCommand(
    REMOTISH_ENSURE_REPOSITORY_COMMAND,
    request(),
  );
  records.set(prepared.workspaceId, {
    provider: 'fixture-provider',
    repository: { repository: 'demo' },
  });
  const firstFs = vscode.__test.fileSystemProviders.get('remotish').provider;
  await firstFs.writeFile(
    workingUri(prepared.workspaceId, '/README.md'),
    new TextEncoder().encode('keep me\n'),
    { create: false, overwrite: true },
  );
  disposeContext(firstContext);

  vscode.__test.reset({ preserveStorage: true });
  const secondContext = createContext({ globalState, root: '/missing-retry' });
  await activate(secondContext);
  t.after(() => disposeContext(secondContext));
  const secondFs = vscode.__test.fileSystemProviders.get('remotish').provider;

  await assert.rejects(
    secondFs.readFile(workingUri(prepared.workspaceId, '/README.md')),
    /provider is not installed or enabled/u,
  );

  const activations = { count: 0 };
  installFixtureProvider({ records, activations });
  const content = await secondFs.readFile(workingUri(prepared.workspaceId, '/README.md'));
  assert.equal(new TextDecoder().decode(content), 'keep me\n');
  assert.equal(activations.count, 1);
});

test('authentication failure during restoration preserves state and later retry succeeds', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());

  const globalState = createMemento();
  const records = new Map();
  installFixtureProvider({ records });
  const firstContext = createContext({ globalState, root: '/auth-retry' });
  await activate(firstContext);
  const prepared = await vscode.commands.executeCommand(
    REMOTISH_ENSURE_REPOSITORY_COMMAND,
    request(),
  );
  records.set(prepared.workspaceId, {
    provider: 'fixture-provider',
    repository: { repository: 'demo' },
  });
  const firstFs = vscode.__test.fileSystemProviders.get('remotish').provider;
  await firstFs.writeFile(
    workingUri(prepared.workspaceId, '/README.md'),
    new TextEncoder().encode('survives auth failure\n'),
    { create: false, overwrite: true },
  );
  disposeContext(firstContext);

  vscode.__test.reset({ preserveStorage: true });
  const failure = {
    error: Object.assign(new Error('login cancelled'), {
      name: 'RemotishError',
      code: 'UNAUTHORIZED',
    }),
  };
  // Use the SDK error class so the filesystem boundary classifies this as NoPermissions.
  const { RemotishError } = await import('@remotish/adapter-sdk');
  failure.error = new RemotishError('UNAUTHORIZED', 'login cancelled');
  installFixtureProvider({ records, restoreFailure: failure });
  const secondContext = createContext({ globalState, root: '/auth-retry' });
  await activate(secondContext);
  t.after(() => disposeContext(secondContext));
  const secondFs = vscode.__test.fileSystemProviders.get('remotish').provider;

  await assert.rejects(
    secondFs.readFile(workingUri(prepared.workspaceId, '/README.md')),
    (error) => error?.code === 'NoPermissions',
  );
  failure.error = undefined;

  const content = await secondFs.readFile(workingUri(prepared.workspaceId, '/README.md'));
  assert.equal(new TextDecoder().decode(content), 'survives auth failure\n');
});
