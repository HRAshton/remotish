import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import { decodeRpcRequest, encodeRpcSuccess } from '@remotish/adapter-rpc';
import {
  REMOTISH_SELECT_PREPARED_BRANCH_COMMAND,
  REMOTISH_SELECT_PREPARED_BRANCH_VERSION,
  RemotishError,
} from '@remotish/adapter-sdk';
import { RemotishProviderHost } from '@remotish/vscode';
import * as vscode from 'vscode';
import {
  BrowserRpcBootstrapFileSystem,
  restoreBrowserRpcWorkspace,
} from '../../extensions/browser-rpc-provider/build/bootstrap.js';
import {
  createBrowserRpcBootstrapUri,
  decodeBrowserRpcBootstrapUri,
} from '../../extensions/browser-rpc-provider/build/bootstrap-uri.js';
import { BrowserRpcEndpointBroker } from '../../extensions/browser-rpc-provider/build/broker.js';
import { createBrowserRpcProvider } from '../../extensions/browser-rpc-provider/build/extension.js';

const target = 'https://example.com/owner/repository';
const encodedTarget = Buffer.from(target).toString('base64url');

function bootstrapUri(branch) {
  const encoded = createBrowserRpcBootstrapUri({ target, ...(branch ? { branch } : {}) });
  const parsed = new URL(encoded);
  return vscode.Uri.from({
    scheme: parsed.protocol.slice(0, -1),
    authority: parsed.host,
    path: parsed.pathname,
    query: parsed.search.slice(1),
  });
}

function memento(values = new Map(), onUpdate = () => {}) {
  return {
    values,
    get(key) {
      return values.get(key);
    },
    async update(key, value) {
      onUpdate(key, value);
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    },
  };
}

function context(globalState, name) {
  return {
    workspaceState: memento(),
    globalState,
    storageUri: vscode.Uri.from({ scheme: 'test-storage', authority: name, path: '/workspace' }),
    globalStorageUri: vscode.Uri.from({ scheme: 'test-storage', authority: name, path: '/global' }),
    subscriptions: [],
  };
}

function fakeEndpoint() {
  const backend = new FixtureAdapter();
  return {
    target,
    session: { version: 1, capabilities: { commits: true } },
    transport: {
      async request(raw, options) {
        const request = decodeRpcRequest(raw);
        switch (request.operation) {
          case 'getRepository':
            return encodeRpcSuccess(request.operation, await backend.getRepository(options));
          case 'getBranches':
            return encodeRpcSuccess(request.operation, await backend.getBranches(options));
          case 'readDirectory':
            return encodeRpcSuccess(
              request.operation,
              await backend.readDirectory(request.payload.revision, request.payload.path, options),
            );
          case 'readFile':
            return encodeRpcSuccess(
              request.operation,
              await backend.readFile(request.payload.revision, request.payload.path, options),
            );
          case 'getCommits':
            return encodeRpcSuccess(
              request.operation,
              await backend.getCommits(request.payload, options),
            );
          case 'getCommitChanges':
            return encodeRpcSuccess(
              request.operation,
              await backend.getCommitChanges(request.payload.revision, options),
            );
          default:
            throw new Error(`Unexpected operation: ${request.operation}`);
        }
      },
    },
  };
}

function installProvider(broker, providerContext) {
  return vscode.__test.installExtension({
    id: 'hrashton.remotish-browser-rpc-provider',
    packageJSON: {
      remotish: {
        provider: true,
        apiVersion: 1,
        id: 'browser-rpc',
        displayName: 'Browser RPC',
      },
    },
    activate() {
      return {
        ...createBrowserRpcProvider(broker),
        async restoreWorkspace(workspaceId) {
          return restoreBrowserRpcWorkspace(providerContext, workspaceId);
        },
      };
    },
  });
}

function errorCode(code) {
  return (error) => error instanceof RemotishError && error.code === code;
}

test('bootstrap URI round-trips an absolute target and slash-bearing branch', () => {
  const uri = createBrowserRpcBootstrapUri({ target, branch: 'feature/topic' });
  assert.equal(uri, `remotish-rpc://open/v1/${encodedTarget}?branch=ZmVhdHVyZS90b3BpYw`);
  assert.deepEqual(decodeBrowserRpcBootstrapUri(uri), { target, branch: 'feature/topic' });
  assert.deepEqual(decodeBrowserRpcBootstrapUri(bootstrapUri('feature/topic')), {
    target,
    branch: 'feature/topic',
  });
  assert.deepEqual(decodeBrowserRpcBootstrapUri(createBrowserRpcBootstrapUri({ target })), {
    target,
  });
});

test('bootstrap URI rejects unknown versions, ambiguous fields, and secret-bearing targets', () => {
  for (const uri of [
    `remotish-rpc://open/v2/${encodedTarget}`,
    `remotish-rpc://other/v1/${encodedTarget}`,
    `remotish-rpc://open/v1/${encodedTarget}?branch=a&branch=b`,
    `remotish-rpc://open/v1/${encodedTarget}?token=secret`,
    `remotish-rpc://open/v1/${encodedTarget}#fragment`,
    `remotish-rpc://open/v1/${Buffer.from('https://user:pass@example.com/repo').toString('base64url')}`,
    `remotish-rpc://open/v1/${Buffer.from('https://example.com/repo?token=secret').toString('base64url')}`,
  ]) {
    assert.throws(() => decodeBrowserRpcBootstrapUri(uri), errorCode('INVALID_REQUEST'));
  }
});

test('branch bootstrap rejects an older host before repository preparation', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());
  const state = memento();
  const bootstrap = new BrowserRpcBootstrapFileSystem(context(state, 'older-host'));
  t.after(() => bootstrap.dispose());
  let preparations = 0;
  const workspaceId = 'browser-rpc-00000000000000000000000000000000';
  const prepare = vscode.commands.registerCommand('remotish.ensureRepository', () => {
    preparations += 1;
    return { version: 1, workspaceId, uri: `remotish://${workspaceId}/` };
  });
  t.after(() => prepare.dispose());

  bootstrap.stat(bootstrapUri('feature/a'));
  await new Promise(setImmediate);
  assert.equal(preparations, 0);
  assert.equal(state.values.size, 0);
  assert.equal(
    vscode.__test.externalCommands.some((item) => item.command === 'vscode.openFolder'),
    false,
  );

  // The optional branch contract does not block links that do not select a branch.
  bootstrap.stat(bootstrapUri());
  await new Promise(setImmediate);
  assert.equal(preparations, 1);
});

test('prepared branch command validates its version and fields', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());
  const host = new RemotishProviderHost(context(memento(), 'branch-contract'));
  t.after(() => host.dispose());
  assert.deepEqual(
    await vscode.commands.executeCommand(REMOTISH_SELECT_PREPARED_BRANCH_COMMAND, {
      version: REMOTISH_SELECT_PREPARED_BRANCH_VERSION,
      operation: 'check',
    }),
    { version: REMOTISH_SELECT_PREPARED_BRANCH_VERSION },
  );
  for (const [request, code] of [
    [{ version: 2, operation: 'check' }, 'UNSUPPORTED'],
    [{ version: 1, operation: 'check', token: 'secret' }, 'INVALID_REQUEST'],
    [{ version: 1, operation: 'select', workspaceId: 'missing' }, 'INVALID_REQUEST'],
    [{ version: 1, operation: 'other' }, 'INVALID_REQUEST'],
  ]) {
    await assert.rejects(
      vscode.commands.executeCommand(REMOTISH_SELECT_PREPARED_BRANCH_COMMAND, request),
      errorCode(code),
    );
  }
});

test('concurrent bootstrap reads wait for an endpoint, persist before navigation, and coalesce', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());
  const events = [];
  const providerState = memento(new Map(), () => events.push('persist'));
  const providerContext = context(providerState, 'bootstrap-provider');
  const broker = new BrowserRpcEndpointBroker();
  const extension = installProvider(broker, providerContext);
  const host = new RemotishProviderHost(context(memento(), 'bootstrap-host'));
  const bootstrap = new BrowserRpcBootstrapFileSystem(providerContext);
  t.after(() => {
    bootstrap.dispose();
    host.dispose();
    broker.dispose();
  });
  let signalNavigation;
  const navigated = new Promise((resolve) => {
    signalNavigation = resolve;
  });
  const originalOpen = vscode.commands.registerCommand('vscode.openFolder', (uri) => {
    events.push('navigate');
    assert.match(uri.toString(), /^remotish:\/\/browser-rpc-[0-9a-f]{32}\/$/u);
    signalNavigation();
  });
  t.after(() => originalOpen.dispose());

  const first = bootstrap.stat(bootstrapUri('feature/test'));
  const second = bootstrap.readDirectory(bootstrapUri('feature/test'));
  await Promise.resolve();
  assert.equal(extension.isActive, false);
  assert.equal(events.length, 0);
  const registration = broker.register({ origin: 'https://example.com' }, fakeEndpoint());
  t.after(() => registration.dispose());
  await navigated;
  assert.equal(first.type, vscode.FileType.Directory);
  assert.deepEqual(second, []);
  assert.deepEqual(events, ['persist', 'navigate']);
  assert.equal(extension.isActive, true);
  assert.equal(providerState.values.size, 1);
  const [workspaceId] = [...providerState.values.keys()].map((key) =>
    key.slice('remotish.browserRpc.restore.v1.'.length),
  );
  assert.equal(host.host.registry.require(workspaceId).workspace.branch, 'feature/test');
  assert.deepEqual([...providerState.values.values()][0], { version: 1, target });
  await bootstrap.stat(bootstrapUri('feature/test'));
  assert.deepEqual(events, ['persist', 'navigate']);
});

test('cold restoration waits for a new endpoint and preserves the working overlay', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());
  const providerState = memento();
  const hostState = memento();
  const firstBroker = new BrowserRpcEndpointBroker();
  installProvider(firstBroker, context(providerState, 'restore-provider'));
  const firstHost = new RemotishProviderHost(context(hostState, 'restore-host'));
  const bootstrap = new BrowserRpcBootstrapFileSystem(context(providerState, 'restore-provider'));
  let signalNavigation;
  const navigated = new Promise((resolve) => {
    signalNavigation = resolve;
  });
  const open = vscode.commands.registerCommand('vscode.openFolder', () => signalNavigation());
  const firstEndpoint = firstBroker.register({ origin: 'https://example.com' }, fakeEndpoint());
  bootstrap.stat(bootstrapUri());
  await navigated;
  open.dispose();
  const [workspaceId] = [...providerState.values.keys()].map((key) =>
    key.slice('remotish.browserRpc.restore.v1.'.length),
  );
  assert.ok(workspaceId);
  const workingFile = vscode.Uri.from({
    scheme: 'remotish',
    authority: workspaceId,
    path: '/README.md',
  });
  const firstFs = vscode.__test.fileSystemProviders.get('remotish').provider;
  await firstFs.writeFile(workingFile, new TextEncoder().encode('saved overlay\n'), {
    create: false,
    overwrite: true,
  });
  await firstHost.host.scm.get(workspaceId).refresh();
  firstEndpoint.dispose();
  bootstrap.dispose();
  firstHost.dispose();
  firstBroker.dispose();

  vscode.__test.reset({ preserveStorage: true });
  const secondBroker = new BrowserRpcEndpointBroker();
  installProvider(secondBroker, context(providerState, 'restore-provider'));
  const secondHost = new RemotishProviderHost(context(hostState, 'restore-host'));
  t.after(() => {
    secondHost.dispose();
    secondBroker.dispose();
  });
  const secondFs = vscode.__test.fileSystemProviders.get('remotish').provider;
  const normalWaitFor = secondBroker.waitFor.bind(secondBroker);
  secondBroker.waitFor = () =>
    Promise.reject(new RemotishError('OFFLINE', 'Endpoint unavailable.'));
  await assert.rejects(secondFs.readFile(workingFile), /Unavailable/u);
  secondBroker.waitFor = normalWaitFor;
  const pending = secondFs.readFile(workingFile);
  let settled = false;
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  assert.equal(settled, false);
  const secondEndpoint = secondBroker.register({ origin: 'https://example.com' }, fakeEndpoint());
  t.after(() => secondEndpoint.dispose());
  assert.equal(new TextDecoder().decode(await pending), 'saved overlay\n');
  await secondHost.host.scm.get(workspaceId).refresh();
});

test('malformed or missing restoration records fail without inventing a repository', () => {
  const state = memento();
  const providerContext = context(state, 'bad-record');
  const workspaceId = 'browser-rpc-00000000000000000000000000000000';
  assert.equal(restoreBrowserRpcWorkspace(providerContext, workspaceId), undefined);
  state.values.set(`remotish.browserRpc.restore.v1.${workspaceId}`, {
    version: 1,
    target,
    token: 'secret',
  });
  assert.throws(
    () => restoreBrowserRpcWorkspace(providerContext, workspaceId),
    errorCode('INVALID_REQUEST'),
  );
});

test('leaving the bootstrap folder cancels late navigation without writing a record', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());
  const state = memento();
  const bootstrap = new BrowserRpcBootstrapFileSystem(context(state, 'cancel-bootstrap'));
  t.after(() => bootstrap.dispose());
  let resolvePreparation;
  const preparation = new Promise((resolve) => {
    resolvePreparation = resolve;
  });
  const command = vscode.commands.registerCommand('remotish.ensureRepository', () => preparation);
  t.after(() => command.dispose());
  bootstrap.stat(bootstrapUri());
  bootstrap.cancel();
  const workspaceId = 'browser-rpc-00000000000000000000000000000000';
  resolvePreparation({ version: 1, workspaceId, uri: `remotish://${workspaceId}/` });
  await preparation;
  await new Promise(setImmediate);
  assert.equal(state.values.size, 0);
  assert.equal(
    vscode.__test.externalCommands.some((item) => item.command === 'vscode.openFolder'),
    false,
  );
});

test('a stale preparation cannot switch the branch after its replacement navigates', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());
  const state = memento();
  const bootstrap = new BrowserRpcBootstrapFileSystem(context(state, 'stale-bootstrap'));
  t.after(() => bootstrap.dispose());
  const workspaceId = 'browser-rpc-00000000000000000000000000000000';
  const result = { version: 1, workspaceId, uri: `remotish://${workspaceId}/` };
  let releaseFirst;
  const first = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let signalStarted;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  let preparations = 0;
  let selectedBranch = 'main';
  const selections = [];
  const prepare = vscode.commands.registerCommand('remotish.ensureRepository', async (request) => {
    preparations += 1;
    if (preparations === 1) {
      signalStarted();
      await first;
    }
    // Model the old host behavior: a branch carried by preparation mutates before it returns.
    if (request.branch) {
      selectedBranch = request.branch;
    }
    return result;
  });
  const select = vscode.commands.registerCommand(
    REMOTISH_SELECT_PREPARED_BRANCH_COMMAND,
    (request) => {
      assert.equal(request.version, REMOTISH_SELECT_PREPARED_BRANCH_VERSION);
      if (request.operation === 'select') {
        selections.push(request.branch);
        selectedBranch = request.branch;
      }
      return { version: REMOTISH_SELECT_PREPARED_BRANCH_VERSION };
    },
  );
  let signalNavigation;
  const navigated = new Promise((resolve) => {
    signalNavigation = resolve;
  });
  const open = vscode.commands.registerCommand('vscode.openFolder', () => signalNavigation());
  t.after(() => {
    prepare.dispose();
    select.dispose();
    open.dispose();
  });

  bootstrap.stat(bootstrapUri('feature/a'));
  await started;
  bootstrap.cancel();
  bootstrap.stat(bootstrapUri('main'));
  await navigated;
  releaseFirst();
  await first;
  await new Promise(setImmediate);
  assert.equal(preparations, 2);
  assert.deepEqual(selections, ['main']);
  assert.equal(selectedBranch, 'main');
  assert.deepEqual([...state.values.values()], [{ version: 1, target }]);
});

test('a newer branch selection waits for an already-started selection', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());
  const bootstrap = new BrowserRpcBootstrapFileSystem(context(memento(), 'selection-order'));
  t.after(() => bootstrap.dispose());
  const workspaceId = 'browser-rpc-00000000000000000000000000000000';
  const result = { version: 1, workspaceId, uri: `remotish://${workspaceId}/` };
  const prepare = vscode.commands.registerCommand('remotish.ensureRepository', () => result);
  let signalFirstSelection;
  const firstSelection = new Promise((resolve) => {
    signalFirstSelection = resolve;
  });
  let releaseFirstSelection;
  const firstSelectionDone = new Promise((resolve) => {
    releaseFirstSelection = resolve;
  });
  let selectedBranch = 'main';
  const select = vscode.commands.registerCommand(
    REMOTISH_SELECT_PREPARED_BRANCH_COMMAND,
    async (request) => {
      assert.equal(request.version, REMOTISH_SELECT_PREPARED_BRANCH_VERSION);
      if (request.operation === 'check') {
        return { version: REMOTISH_SELECT_PREPARED_BRANCH_VERSION };
      }
      if (request.branch === 'feature/a') {
        signalFirstSelection();
        await firstSelectionDone;
      }
      selectedBranch = request.branch;
      return { version: REMOTISH_SELECT_PREPARED_BRANCH_VERSION };
    },
  );
  let signalNavigation;
  const navigated = new Promise((resolve) => {
    signalNavigation = resolve;
  });
  const open = vscode.commands.registerCommand('vscode.openFolder', () => signalNavigation());
  t.after(() => {
    prepare.dispose();
    select.dispose();
    open.dispose();
  });

  bootstrap.stat(bootstrapUri('feature/a'));
  await firstSelection;
  bootstrap.cancel();
  bootstrap.stat(bootstrapUri('main'));
  releaseFirstSelection();
  await navigated;
  assert.equal(selectedBranch, 'main');
});

test('navigation failure retains reconstruction data without repeated background preparation', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());
  const state = memento();
  const bootstrap = new BrowserRpcBootstrapFileSystem(context(state, 'retry-bootstrap'));
  t.after(() => bootstrap.dispose());
  const workspaceId = 'browser-rpc-00000000000000000000000000000000';
  let preparations = 0;
  let navigations = 0;
  const prepare = vscode.commands.registerCommand('remotish.ensureRepository', () => {
    preparations += 1;
    return { version: 1, workspaceId, uri: `remotish://${workspaceId}/` };
  });
  const open = vscode.commands.registerCommand('vscode.openFolder', () => {
    navigations += 1;
    if (navigations === 1) {
      throw new Error('navigation unavailable');
    }
  });
  t.after(() => {
    prepare.dispose();
    open.dispose();
  });
  bootstrap.stat(bootstrapUri());
  await new Promise(setImmediate);
  assert.equal(navigations, 1);
  assert.deepEqual([...state.values.values()], [{ version: 1, target }]);
  bootstrap.stat(bootstrapUri());
  await new Promise(setImmediate);
  assert.equal(preparations, 1);
  assert.equal(navigations, 1);
  bootstrap.cancel();
  bootstrap.stat(bootstrapUri());
  await new Promise(setImmediate);
  assert.equal(preparations, 2);
  assert.equal(navigations, 2);
});
