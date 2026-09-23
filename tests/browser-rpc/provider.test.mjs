import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import { decodeRpcRequest, encodeRpcSuccess } from '@remotish/adapter-rpc';
import { REMOTISH_ENSURE_REPOSITORY_COMMAND, RemotishError } from '@remotish/adapter-sdk';
import * as vscode from 'vscode';

import { activate as activateHost } from '../../apps/demo-web/build/extension.js';
import { BrowserRpcEndpointBroker } from '../../extensions/browser-rpc-provider/build/broker.js';
import { createBrowserRpcProvider } from '../../extensions/browser-rpc-provider/build/extension.js';
import {
  decodeBrowserRpcRepository,
  normalizeBrowserRpcTarget,
} from '../../extensions/browser-rpc-provider/build/target.js';

const target = 'https://example.com/owner/repository';
const manifest = JSON.parse(
  await readFile(new URL('../../extensions/browser-rpc-provider/package.json', import.meta.url)),
);

function fakeEndpoint(backend = new FixtureAdapter()) {
  const calls = [];
  const endpoint = {
    target,
    session: { version: 1, capabilities: { commits: false } },
    transport: {
      async request(raw, options) {
        const request = decodeRpcRequest(raw);
        calls.push(request.operation);
        switch (request.operation) {
          case 'getRepository':
            return encodeRpcSuccess(request.operation, await backend.getRepository(options));
          case 'getBranches':
            return encodeRpcSuccess(request.operation, await backend.getBranches(options));
          case 'readFile':
            return encodeRpcSuccess(
              request.operation,
              await backend.readFile(request.payload.revision, request.payload.path, options),
            );
          default:
            throw new Error('Unexpected fake endpoint operation.');
        }
      },
    },
  };
  Object.defineProperty(endpoint, 'calls', { value: calls });
  return endpoint;
}

function context() {
  const values = new Map();
  const memento = {
    get(key, fallback) {
      return values.has(key) ? values.get(key) : fallback;
    },
    async update(key, value) {
      values.set(key, value);
    },
  };
  return {
    workspaceState: memento,
    globalState: memento,
    storageUri: vscode.Uri.from({
      scheme: 'test-storage',
      authority: 'workspace',
      path: '/browser-rpc',
    }),
    globalStorageUri: vscode.Uri.from({
      scheme: 'test-storage',
      authority: 'global',
      path: '/browser-rpc',
    }),
    subscriptions: [],
  };
}

function request(repository = { target }) {
  return { version: 1, provider: 'browser-rpc', repository };
}

function errorCode(code) {
  return (error) => error instanceof RemotishError && error.code === code;
}

test('descriptor is strict, canonical, and credential-free', () => {
  assert.equal(normalizeBrowserRpcTarget('HTTPS://EXAMPLE.COM:443/owner/repository'), target);
  assert.equal(
    normalizeBrowserRpcTarget('http://localhost:8080/repository'),
    'http://localhost:8080/repository',
  );
  assert.equal(decodeBrowserRpcRepository({ target }), target);
  for (const bad of [
    'http://example.com/repo',
    'ftp://example.com/repo',
    'https://user:pass@example.com/repo',
    'https://example.com/repo?token=secret',
    'https://example.com/repo#secret',
    'https://example.com\\repo',
    'https://example.com/repo\n',
  ]) {
    assert.throws(() => normalizeBrowserRpcTarget(bad), errorCode('INVALID_REQUEST'));
  }
  for (const bad of [null, [], {}, { target, branch: 'main' }, { target, token: 'secret' }]) {
    assert.throws(() => decodeBrowserRpcRepository(bad), errorCode('INVALID_REQUEST'));
  }
});

test('broker enforces trusted origin and validates endpoint/session before registration', () => {
  const broker = new BrowserRpcEndpointBroker();
  const endpoint = fakeEndpoint();
  assert.throws(
    () => broker.register({ origin: 'https://other.example' }, endpoint),
    errorCode('INVALID_REQUEST'),
  );
  assert.throws(
    () => broker.register({ origin: 'https://example.com/repository' }, endpoint),
    errorCode('INVALID_REQUEST'),
  );
  for (const metadata of [null, {}, { origin: 'https://example.com', claim: 'other' }]) {
    assert.throws(() => broker.register(metadata, endpoint), errorCode('INVALID_REQUEST'));
  }
  for (const malformed of [
    null,
    {},
    { ...endpoint, extra: true },
    { ...endpoint, transport: {} },
  ]) {
    assert.throws(
      () => broker.register({ origin: 'https://example.com' }, malformed),
      errorCode('INVALID_REQUEST'),
    );
  }
  for (const session of [
    { version: 2, capabilities: { commits: false } },
    { version: 1, capabilities: { commits: false, forceWithLease: true } },
    { version: 1, capabilities: { commits: 'yes' } },
  ]) {
    assert.throws(
      () => broker.register({ origin: 'https://example.com' }, { ...endpoint, session }),
      RemotishError,
    );
  }
  assert.equal(broker.find(target), undefined);
  broker.dispose();
});

test('waiting ignores nonmatches, resolves concurrent callers, and disposal removes availability', async () => {
  const broker = new BrowserRpcEndpointBroker();
  const first = broker.waitFor(target);
  const second = broker.waitFor(target);
  const wrong = broker.register(
    { origin: 'https://other.example' },
    { ...fakeEndpoint(), target: 'https://other.example/repository' },
  );
  await Promise.resolve();
  assert.equal(broker.find(target), undefined);
  wrong.dispose();
  const endpoint = fakeEndpoint();
  const registration = broker.register({ origin: 'https://example.com' }, endpoint);
  assert.deepEqual(await Promise.all([first, second]), [broker.find(target), broker.find(target)]);
  registration.dispose();
  assert.equal(broker.find(target), undefined);
  broker.dispose();
});

test('ambiguous endpoints reject deterministically, including pending waiters', async () => {
  const broker = new BrowserRpcEndpointBroker();
  const pending = broker.waitFor(target);
  const first = broker.register({ origin: 'https://example.com' }, fakeEndpoint());
  const second = broker.register({ origin: 'https://example.com' }, fakeEndpoint());
  await assert.rejects(pending, errorCode('INVALID_REQUEST'));
  assert.throws(() => broker.find(target), errorCode('INVALID_REQUEST'));
  first.dispose();
  assert.ok(broker.find(target));
  second.dispose();
  broker.dispose();
});

test('abort removes a waiter; timeout and broker disposal have deliberate classification', async () => {
  const broker = new BrowserRpcEndpointBroker();
  const controller = new AbortController();
  const pending = broker.waitFor(target, { signal: controller.signal });
  const unaffected = broker.waitFor(target);
  controller.abort();
  await assert.rejects(pending, errorCode('CANCELLED'));
  const endpoint = fakeEndpoint();
  broker.register({ origin: 'https://example.com' }, endpoint);
  assert.deepEqual(await unaffected, broker.find(target));
  await assert.rejects(
    broker.waitFor(target, { signal: controller.signal }),
    errorCode('CANCELLED'),
  );
  broker.dispose();

  const empty = new BrowserRpcEndpointBroker();
  await assert.rejects(empty.waitFor(target, { timeoutMs: 0 }), errorCode('OFFLINE'));
  const closing = empty.waitFor(target);
  empty.dispose();
  await assert.rejects(closing, errorCode('OFFLINE'));
  assert.throws(
    () => empty.register({ origin: 'https://example.com' }, fakeEndpoint()),
    errorCode('OFFLINE'),
  );
});

test('provider waits for a matching endpoint then forwards RPC calls through the adapter', async () => {
  const broker = new BrowserRpcEndpointBroker();
  const provider = createBrowserRpcProvider(broker);
  provider.validateRepository({ target });
  const pending = provider.createAdapter({ target });
  const endpoint = fakeEndpoint();
  broker.register({ origin: 'https://example.com' }, endpoint);
  const adapter = await pending;
  assert.equal((await adapter.getRepository()).id, 'fixture/demo');
  assert.deepEqual(
    await adapter.readFile('C3', 'assets/sample.bin'),
    new Uint8Array([0, 1, 2, 127, 128, 255]),
  );
  assert.deepEqual(endpoint.calls, ['getRepository', 'readFile']);
  broker.dispose();
});

test('host discovers manifest without activation and activates only for repository preparation', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());
  const broker = new BrowserRpcEndpointBroker();
  t.after(() => broker.dispose());
  let activations = 0;
  let signalActivated;
  const activated = new Promise((resolve) => {
    signalActivated = resolve;
  });
  const extension = vscode.__test.installExtension({
    id: `${manifest.publisher}.${manifest.name}`,
    packageJSON: manifest,
    activate() {
      activations += 1;
      signalActivated();
      return createBrowserRpcProvider(broker);
    },
  });
  const hostContext = context();
  await activateHost(hostContext);
  t.after(() => {
    for (const subscription of [...hostContext.subscriptions].reverse()) {
      subscription.dispose();
    }
  });
  assert.equal(activations, 0);
  assert.equal(extension.isActive, false);

  const pending = vscode.commands.executeCommand(REMOTISH_ENSURE_REPOSITORY_COMMAND, request());
  await activated;
  await extension.activate();
  assert.equal(extension.isActive, true);
  const endpoint = fakeEndpoint();
  broker.register({ origin: 'https://example.com' }, endpoint);
  const prepared = await pending;
  assert.match(prepared.uri, /^remotish:\/\/browser-rpc-[0-9a-f]{32}\/$/u);
  assert.equal(activations, 1);
  assert.ok(endpoint.calls.includes('getRepository'));
  assert.ok(endpoint.calls.includes('getBranches'));
});
