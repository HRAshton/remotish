import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import { RemotishError } from '@remotish/adapter-sdk';
import { MemoryWorkspaceStorage, RemotishWorkspace } from '@remotish/core';
import * as vscode from 'vscode';

import { BrowserRpcEndpointBroker } from '../../extensions/browser-rpc-provider/build/broker.js';
import {
  activate as activateProvider,
  createBrowserRpcProvider,
} from '../../extensions/browser-rpc-provider/build/extension.js';
import { GmMailbox } from '../../extensions/browser-rpc-provider/build/transport/gm-mailbox.js';
import { BrowserRpcHostTransport } from '../../extensions/browser-rpc-provider/build/transport/host.js';
import {
  BrowserRpcUserscriptEndpoint,
  BrowserRpcUserscriptHostRelay,
} from '../../extensions/browser-rpc-provider/build/transport/userscript.js';
import {
  decodeFrame,
  decryptFrame,
  encryptFrame,
  importBridgeKey,
} from '../../extensions/browser-rpc-provider/build/transport/wire.js';

const target = 'https://scm.example/repository';
const session = { version: 1, capabilities: { commits: false } };

class Bus {
  channels = new Set();
  packets = [];

  channel() {
    const channel = {
      onmessage: null,
      postMessage: (data) => {
        this.packets.push(data);
        for (const other of this.channels) {
          if (other !== channel) {
            queueMicrotask(() => other.onmessage?.({ data }));
          }
        }
      },
      close: () => this.channels.delete(channel),
    };
    this.channels.add(channel);
    return channel;
  }

  inject(data) {
    for (const channel of this.channels) {
      queueMicrotask(() => channel.onmessage?.({ data }));
    }
  }
}

class Storage {
  values = new Map();
  listeners = new Map();
  nextId = 1;

  getValue(name) {
    return this.values.get(name);
  }
  listValues() {
    return [...this.values.keys()];
  }
  setValue(name, value) {
    const old = this.values.get(name);
    this.values.set(name, value);
    for (const { key, callback } of this.listeners.values()) {
      if (key === name) {
        queueMicrotask(() => callback(name, old, value, true));
      }
    }
  }
  deleteValue(name) {
    this.values.delete(name);
  }
  addValueChangeListener(key, callback) {
    const id = this.nextId++;
    this.listeners.set(id, { key, callback });
    return id;
  }
  removeValueChangeListener(id) {
    this.listeners.delete(id);
  }
}

async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Browser RPC event did not arrive');
}

function fixtureHandler(backend = new FixtureAdapter()) {
  return {
    target,
    session,
    async handle(request, signal) {
      const options = { signal };
      switch (request.operation) {
        case 'getRepository':
          return backend.getRepository(options);
        case 'getBranches':
          return backend.getBranches(options);
        case 'readDirectory':
          return backend.readDirectory(request.payload.revision, request.payload.path, options);
        case 'readFile':
          return backend.readFile(request.payload.revision, request.payload.path, options);
        default:
          throw new RemotishError('UNSUPPORTED', 'Unsupported fixture operation.');
      }
    },
  };
}

async function setup(t, handler = fixtureHandler()) {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://scm.example' },
  });
  t.after(() => {
    if (previousLocation) {
      Object.defineProperty(globalThis, 'location', previousLocation);
    } else {
      Reflect.deleteProperty(globalThis, 'location');
    }
  });
  const key = await importBridgeKey(randomBytes(32).toString('base64url'));
  const bus = new Bus();
  const storage = new Storage();
  const broker = new BrowserRpcEndpointBroker();
  const host = new BrowserRpcHostTransport(broker, key, bus.channel());
  const relay = new BrowserRpcUserscriptHostRelay(storage, key, bus.channel());
  const endpoint = new BrowserRpcUserscriptEndpoint(storage, key, handler);
  t.after(async () => {
    await endpoint.dispose();
    host.dispose();
    relay.dispose();
    broker.dispose();
  });
  await endpoint.start();
  await host.start();
  await eventually(() => broker.find(target));
  return { key, bus, storage, broker, host, relay, endpoint };
}

test('frames reject unknown versions, fields, and forged ciphertext', async () => {
  const key = await importBridgeKey(randomBytes(32).toString('base64url'));
  assert.throws(
    () => decodeFrame({ version: 2, kind: 'hello', hostId: 'a'.repeat(32) }),
    RemotishError,
  );
  assert.throws(() => decodeFrame({ version: 1, kind: 'request', extra: 1 }), RemotishError);
  const packet = await encryptFrame(key, { version: 1, kind: 'hello', hostId: 'a'.repeat(32) });
  assert.deepEqual(await decryptFrame(key, packet), {
    version: 1,
    kind: 'hello',
    hostId: 'a'.repeat(32),
  });
  await assert.rejects(
    decryptFrame(await importBridgeKey(randomBytes(32).toString('base64url')), packet),
    RemotishError,
  );
  await assert.rejects(decryptFrame(key, packet.slice(0, -5)), RemotishError);
  await assert.rejects(
    encryptFrame(key, {
      version: 1,
      kind: 'response',
      hostId: 'a'.repeat(32),
      endpointId: 'b'.repeat(32),
      requestId: 'c'.repeat(32),
      response: 'x'.repeat(25 * 1024 * 1024),
    }),
    (error) => error instanceof RemotishError && error.code === 'INVALID_REQUEST',
  );
});

test('GM mailbox chunks packets and ignores duplicate wake/poll delivery', async (t) => {
  const storage = new Storage();
  const received = [];
  const sender = new GmMailbox(storage, (packet) => received.push(`sender:${packet}`));
  const receiver = new GmMailbox(storage, (packet) => received.push(packet));
  t.after(() => {
    sender.dispose();
    receiver.dispose();
  });
  const packet = 'x'.repeat(300_000);
  await sender.send(packet);
  await receiver.poll();
  await eventually(() => received.length === 1);
  await receiver.poll();
  assert.equal(received.length, 1);
  assert.equal(received[0], packet);
});

test('two-tab handshake, binary read, disconnect, reload and replay rejection', async (t) => {
  const { key, bus, storage, broker, endpoint } = await setup(t);
  const provider = createBrowserRpcProvider(broker);
  const adapter = await provider.createAdapter({ target });
  assert.equal((await adapter.getRepository()).id, 'fixture/demo');
  assert.deepEqual(
    await adapter.readFile('C3', 'assets/sample.bin'),
    new Uint8Array([0, 1, 2, 127, 128, 255]),
  );
  const oldRegister = bus.packets.find((packet) => packet.includes('ciphertext'));
  const oldId = endpoint.endpointId;
  await endpoint.dispose();
  await eventually(() => broker.find(target) === undefined);
  for (const packet of bus.packets) {
    const frame = await decryptFrame(key, packet);
    if (frame.kind === 'register' && frame.endpointId === oldId) {
      bus.inject(packet);
      break;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(broker.find(target), undefined);
  assert.ok(oldRegister);
  const replacement = new BrowserRpcUserscriptEndpoint(storage, key, fixtureHandler());
  t.after(async () => replacement.dispose());
  await replacement.start();
  await eventually(() => broker.find(target));
  assert.notEqual(replacement.endpointId, oldId);
  assert.equal((await adapter.getRepository()).id, 'fixture/demo');
});

test('abort frees an endpoint slot even when a handler ignores its signal', async (t) => {
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  let finish;
  const hung = new Promise((resolve) => {
    finish = resolve;
  });
  const handler = fixtureHandler();
  const original = handler.handle;
  handler.handle = (request, signal) => {
    if (request.operation === 'readFile') {
      started();
      return hung;
    }
    return original(request, signal);
  };
  const { broker } = await setup(t, handler);
  const adapter = await createBrowserRpcProvider(broker).createAdapter({ target });
  const controller = new AbortController();
  const pending = adapter.readFile('C3', 'assets/sample.bin', { signal: controller.signal });
  await entered;
  controller.abort();
  await assert.rejects(
    pending,
    (error) => error instanceof RemotishError && error.code === 'CANCELLED',
  );
  finish(new Uint8Array([9]));
  assert.equal((await adapter.getRepository()).id, 'fixture/demo');
});

test('host rejects bad origin, duplicate sessions, and stale registration replay', async (t) => {
  const key = await importBridgeKey(randomBytes(32).toString('base64url'));
  const bus = new Bus();
  const broker = new BrowserRpcEndpointBroker();
  let now = 100_000;
  const host = new BrowserRpcHostTransport(broker, key, bus.channel(), () => now);
  t.after(() => {
    host.dispose();
    broker.dispose();
  });
  const register = (endpointId, origin = 'https://scm.example') => ({
    version: 1,
    kind: 'register',
    hostId: host.hostId,
    endpointId,
    counter: 1,
    origin,
    target,
    session,
  });
  await assert.rejects(
    host.receive(await encryptFrame(key, register('a'.repeat(32), 'https://other.example'))),
    RemotishError,
  );
  assert.equal(broker.find(target), undefined);
  await host.receive(
    await encryptFrame(key, {
      version: 1,
      kind: 'disconnect',
      hostId: host.hostId,
      endpointId: 'f'.repeat(32),
      counter: 2,
    }),
  );
  await host.receive(await encryptFrame(key, register('f'.repeat(32))));
  assert.equal(broker.find(target), undefined);
  const first = await encryptFrame(key, register('b'.repeat(32)));
  await host.receive(first);
  assert.ok(broker.find(target));
  await host.receive(await encryptFrame(key, register('c'.repeat(32))));
  assert.throws(() => broker.find(target), RemotishError);
  now += 16_000;
  host.sweep();
  assert.equal(broker.find(target), undefined);
  await host.receive(first);
  assert.equal(broker.find(target), undefined);
});

test('endpoint rejects an unknown RPC method without invoking its handler', async (t) => {
  let calls = 0;
  const handler = fixtureHandler();
  const original = handler.handle;
  handler.handle = (request, signal) => {
    calls += 1;
    return original(request, signal);
  };
  const { key, bus, host, endpoint } = await setup(t, handler);
  const requestId = 'd'.repeat(32);
  bus.inject(
    await encryptFrame(key, {
      version: 1,
      kind: 'request',
      hostId: host.hostId,
      endpointId: endpoint.endpointId,
      requestId,
      request: { version: 1, operation: 'unsafeMethod', payload: {} },
    }),
  );
  await eventually(async () => {
    const frames = await Promise.all(bus.packets.map((packet) => decryptFrame(key, packet)));
    return frames.some((frame) => frame.kind === 'response' && frame.requestId === requestId);
  });
  const responses = await Promise.all(bus.packets.map((packet) => decryptFrame(key, packet)));
  assert.ok(
    responses.some(
      (frame) =>
        frame.kind === 'response' &&
        frame.requestId === requestId &&
        frame.response.status === 'error' &&
        frame.response.error.code === 'INVALID_REQUEST',
    ),
  );
  assert.equal(calls, 0);
});

test('cancellation arriving before a request prevents delayed execution', async (t) => {
  let calls = 0;
  const handler = fixtureHandler();
  const original = handler.handle;
  handler.handle = (request, signal) => {
    calls += 1;
    return original(request, signal);
  };
  const { key, host, endpoint } = await setup(t, handler);
  const requestId = 'e'.repeat(32);
  await endpoint.receive(
    await encryptFrame(key, {
      version: 1,
      kind: 'cancel',
      hostId: host.hostId,
      endpointId: endpoint.endpointId,
      requestId,
    }),
  );
  await endpoint.receive(
    await encryptFrame(key, {
      version: 1,
      kind: 'request',
      hostId: host.hostId,
      endpointId: endpoint.endpointId,
      requestId,
      request: { version: 1, operation: 'getRepository', payload: {} },
    }),
  );
  assert.equal(calls, 0);
});

test('a sixteen-megabyte binary file round-trips within the explicit packet limit', async (t) => {
  const bytes = new Uint8Array(16 * 1024 * 1024);
  bytes[0] = 255;
  bytes[bytes.length - 1] = 128;
  const handler = fixtureHandler();
  const original = handler.handle;
  handler.handle = (request, signal) =>
    request.operation === 'readFile' ? Promise.resolve(bytes) : original(request, signal);
  const { broker } = await setup(t, handler);
  const adapter = await createBrowserRpcProvider(broker).createAdapter({ target });
  const read = await adapter.readFile('C3', 'assets/sample.bin');
  assert.equal(read.length, bytes.length);
  assert.equal(read[0], 255);
  assert.equal(read[read.length - 1], 128);
});

test('an unsendable commit is settled without entering uncertain-publication recovery', async (t) => {
  let published = 0;
  const handler = fixtureHandler();
  handler.session = { version: 1, capabilities: { commits: true } };
  const original = handler.handle;
  handler.handle = (request, signal) => {
    if (request.operation === 'commit') {
      published += 1;
    }
    return original(request, signal);
  };
  const { broker, bus, key } = await setup(t, handler);
  const adapter = await createBrowserRpcProvider(broker).createAdapter({ target });
  const workspace = await RemotishWorkspace.open(adapter, new MemoryWorkspaceStorage());
  await workspace.writeFile('large.bin', new Uint8Array(18 * 1024 * 1024), {
    create: true,
    overwrite: true,
  });
  const result = await workspace.commitAndPush('Too large for this transport');
  assert.deepEqual(result, {
    status: 'rejected',
    reason: 'UNSUPPORTED',
    message: 'Browser RPC commit exceeds the transport size limit.',
  });
  assert.equal(published, 0);
  const frames = await Promise.all(bus.packets.map((packet) => decryptFrame(key, packet)));
  assert.equal(
    frames.some((frame) => frame.kind === 'request' && frame.request.operation === 'commit'),
    false,
  );
  assert.equal(workspace.baseRevision, 'C3');
  await workspace.writeFile('README.md', new TextEncoder().encode('still editable\n'), {
    create: false,
    overwrite: true,
  });
});

test('a postMessage failure during publication remains an uncertain outcome', async (t) => {
  const handler = fixtureHandler();
  handler.session = { version: 1, capabilities: { commits: true } };
  const { broker, host } = await setup(t, handler);
  const adapter = await createBrowserRpcProvider(broker).createAdapter({ target });
  const workspace = await RemotishWorkspace.open(adapter, new MemoryWorkspaceStorage());
  await workspace.writeFile('README.md', new TextEncoder().encode('local change\n'), {
    create: false,
    overwrite: true,
  });
  host.channel.postMessage = () => {
    throw new Error('ambiguous browser dispatch failure');
  };
  await assert.rejects(
    workspace.commitAndPush('Keep publication uncertain'),
    (error) => error instanceof RemotishError && error.code === 'OFFLINE',
  );
  await assert.rejects(
    workspace.writeFile('README.md', new TextEncoder().encode('do not mutate\n'), {
      create: false,
      overwrite: true,
    }),
    /uncertain outcome/u,
  );
});

test('an oversized file response returns an explicit error instead of timing out', async (t) => {
  const handler = fixtureHandler();
  const original = handler.handle;
  handler.handle = (request, signal) =>
    request.operation === 'readFile'
      ? Promise.resolve(new Uint8Array(18 * 1024 * 1024))
      : original(request, signal);
  const { broker } = await setup(t, handler);
  const adapter = await createBrowserRpcProvider(broker).createAdapter({ target });
  await assert.rejects(
    adapter.readFile('C3', 'assets/sample.bin'),
    (error) => error instanceof RemotishError && error.code === 'INVALID_REQUEST',
  );
});

test('an open adapter reconnects after the customer rotates the pairing key', async (t) => {
  vscode.__test.reset();
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const previousChannel = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://scm.example' },
  });
  const bus = new Bus();
  Object.defineProperty(globalThis, 'BroadcastChannel', {
    configurable: true,
    value: class {
      channel = bus.channel();
      get onmessage() {
        return this.channel.onmessage;
      }
      set onmessage(handler) {
        this.channel.onmessage = handler;
      }
      postMessage(value) {
        this.channel.postMessage(value);
      }
      close() {
        this.channel.close();
      }
    },
  });
  const secrets = new Map();
  const context = {
    secrets: {
      get: async (name) => secrets.get(name),
      store: async (name, value) => {
        secrets.set(name, value);
      },
    },
    subscriptions: [],
  };
  const provider = activateProvider(context);
  let firstEndpoint;
  let firstRelay;
  let secondEndpoint;
  let secondRelay;
  t.after(async () => {
    await secondEndpoint?.dispose();
    secondRelay?.dispose();
    await firstEndpoint?.dispose();
    firstRelay?.dispose();
    for (const subscription of context.subscriptions) {
      subscription.dispose();
    }
    if (previousLocation) {
      Object.defineProperty(globalThis, 'location', previousLocation);
    } else {
      Reflect.deleteProperty(globalThis, 'location');
    }
    if (previousChannel) {
      Object.defineProperty(globalThis, 'BroadcastChannel', previousChannel);
    } else {
      Reflect.deleteProperty(globalThis, 'BroadcastChannel');
    }
    vscode.__test.reset();
  });
  const storage = new Storage();
  const firstKeyString = randomBytes(32).toString('base64url');
  const firstKey = await importBridgeKey(firstKeyString);
  await vscode.commands.executeCommand('remotish.browserRpc.configureBridge', firstKeyString);
  firstRelay = new BrowserRpcUserscriptHostRelay(storage, firstKey, bus.channel());
  firstEndpoint = new BrowserRpcUserscriptEndpoint(storage, firstKey, fixtureHandler());
  await firstEndpoint.start();
  const adapter = await provider.createAdapter({ target });
  assert.equal((await adapter.getRepository()).id, 'fixture/demo');

  const secondKeyString = randomBytes(32).toString('base64url');
  const secondKey = await importBridgeKey(secondKeyString);
  await vscode.commands.executeCommand('remotish.browserRpc.configureBridge', secondKeyString);
  await firstEndpoint.dispose();
  firstRelay.dispose();
  secondRelay = new BrowserRpcUserscriptHostRelay(storage, secondKey, bus.channel());
  secondEndpoint = new BrowserRpcUserscriptEndpoint(storage, secondKey, fixtureHandler());
  await secondEndpoint.start();
  assert.equal((await adapter.getRepository()).id, 'fixture/demo');
});
