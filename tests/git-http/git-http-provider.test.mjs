import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import * as vscode from 'vscode';
import {
  CHANNEL,
  decrypt,
  encrypt,
  importKey,
} from '../../extensions/git-http-provider/build/bridge-wire.js';
import { desktopGitRequest } from '../../extensions/git-http-provider/build/desktop-http.js';
import {
  activate,
  decodeGitRepository,
} from '../../extensions/git-http-provider/build/extension.js';
import { activate as activateDesktop } from '../../extensions/git-http-provider/build/extension-desktop.js';

const URL = 'https://git.example.invalid/scm/PRJ/repo.git';
const ID = `git-http-${'a'.repeat(32)}`;

function context() {
  const secrets = new Map();
  const records = new Map();
  return {
    subscriptions: [],
    secrets: {
      get: async (key) => secrets.get(key),
      store: async (key, value) => {
        secrets.set(key, value);
      },
    },
    globalState: {
      get: (key) => records.get(key),
      update: async (key, value) => {
        records.set(key, value);
      },
    },
    secretsState: secrets,
    records,
  };
}

test('provider validates URL-only descriptors and keeps desktop token out of restoration', async (t) => {
  vscode.__test.reset();
  const state = context();
  const provider = activateDesktop(state);
  t.after(() =>
    state.subscriptions.forEach((item) => {
      item.dispose();
    }),
  );
  assert.equal(provider.id, 'git-http');
  assert.equal(decodeGitRepository({ url: URL }), URL);
  for (const descriptor of [
    { url: URL, token: 'secret' },
    { url: 'http://git.example.invalid/repo.git' },
    { url: 'https://name:password@git.example.invalid/repo.git' },
    { url: `${URL}?token=secret` },
  ]) {
    assert.throws(() => provider.validateRepository(descriptor));
  }
  vscode.__test.inputBoxResponses.push(
    URL,
    'Pilot Author',
    'pilot@example.invalid',
    'desktop-token',
  );
  await vscode.commands.executeCommand('remotish.gitHttp.configure');
  assert.deepEqual([...state.secretsState.keys()], ['remotish.gitHttp.token.v1']);
  await assert.rejects(
    provider.createAdapter({ url: 'https://other.example.invalid/repo.git' }),
    /differs/,
  );
  const adapter = await provider.createAdapter({ url: URL });
  assert.equal(adapter.capabilities.forceWithLease, true);

  const ensure = vscode.commands.registerCommand('remotish.ensureRepository', (request) => {
    assert.deepEqual(request.repository, { url: URL });
    return { version: 1, workspaceId: ID, uri: `remotish://${ID}/` };
  });
  t.after(() => ensure.dispose());
  await vscode.commands.executeCommand('remotish.gitHttp.open');
  assert.deepEqual(state.records.get(`remotish.gitHttp.restore.v1.${ID}`), {
    version: 1,
    url: URL,
  });
  assert.deepEqual(await provider.restoreWorkspace(ID), {
    provider: 'git-http',
    repository: { url: URL },
  });
  assert.equal(vscode.__test.externalCommands.at(-1).command, 'vscode.openFolder');
  state.records.set(`remotish.gitHttp.restore.v1.${ID}`, { version: 1, url: URL, token: 'leak' });
  await assert.rejects(provider.restoreWorkspace(ID), /restoration/);
});

test('Web provider stores only a pairing key and does not ask VS Code for a token', async (t) => {
  vscode.__test.reset();
  vscode.env.uiKind = vscode.UIKind.Web;
  const state = context();
  const provider = activate(state);
  t.after(() =>
    state.subscriptions.forEach((item) => {
      item.dispose();
    }),
  );
  const pairing = randomBytes(32).toString('base64url');
  vscode.__test.inputBoxResponses.push(URL, 'Pilot Author', 'pilot@example.invalid', pairing);
  await vscode.commands.executeCommand('remotish.gitHttp.configure');
  assert.deepEqual([...state.secretsState.keys()], ['remotish.gitHttp.pairingKey.v1']);
  await assert.rejects(provider.createAdapter({ url: URL }), (error) => error.code === 'OFFLINE');
  assert.deepEqual([...state.secretsState.keys()], ['remotish.gitHttp.pairingKey.v1']);
});

test('an open desktop adapter uses the rotated bearer token', async (t) => {
  vscode.__test.reset();
  const state = context();
  const provider = activateDesktop(state);
  t.after(() =>
    state.subscriptions.forEach((item) => {
      item.dispose();
    }),
  );
  vscode.__test.inputBoxResponses.push(URL, 'Pilot Author', 'pilot@example.invalid', 'first-token');
  await vscode.commands.executeCommand('remotish.gitHttp.configure');
  const adapter = await provider.createAdapter({ url: URL });
  const originalFetch = globalThis.fetch;
  const tokens = [];
  globalThis.fetch = async (url, init) => {
    tokens.push(init.headers.Authorization);
    const response = new Response('', { status: 401 });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  try {
    await assert.rejects(adapter.getRepository(), (error) => error.code === 'UNAUTHORIZED');
    vscode.__test.inputBoxResponses.push(
      URL,
      'Pilot Author',
      'pilot@example.invalid',
      'second-token',
    );
    await vscode.commands.executeCommand('remotish.gitHttp.configure');
    await assert.rejects(adapter.getRepository(), (error) => error.code === 'UNAUTHORIZED');
    assert.deepEqual(tokens, ['Bearer first-token', 'Bearer second-token']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an open Web adapter reconnects with the rotated pairing key', async (t) => {
  vscode.__test.reset();
  vscode.env.uiKind = vscode.UIKind.Web;
  const state = context();
  const provider = activate(state);
  const channel = new BroadcastChannel(CHANNEL);
  t.after(() => {
    channel.close();
    state.subscriptions.forEach((item) => {
      item.dispose();
    });
  });
  const firstPairing = randomBytes(32).toString('base64url');
  const secondPairing = randomBytes(32).toString('base64url');
  let key = await importKey(firstPairing);
  let generation = 'first';
  const requests = [];
  const errors = [];
  channel.onmessage = (event) => {
    const handle = async () => {
      let frame;
      try {
        frame = await decrypt(key, event.data);
      } catch {
        return;
      }
      if (frame.kind === 'hello-request') {
        channel.postMessage(
          await encrypt(key, {
            version: 1,
            kind: 'hello',
            hostId: frame.hostId,
            id: frame.id,
            sessionId: 'a'.repeat(32),
          }),
        );
      } else if (frame.kind === 'request') {
        requests.push(generation);
        channel.postMessage(
          await encrypt(key, {
            version: 1,
            kind: 'failure',
            hostId: frame.hostId,
            id: frame.id,
            sessionId: frame.sessionId,
            code: 'UNAUTHORIZED',
          }),
        );
      }
    };
    handle().catch((error) => {
      errors.push(error);
    });
  };
  vscode.__test.inputBoxResponses.push(URL, 'Pilot Author', 'pilot@example.invalid', firstPairing);
  await vscode.commands.executeCommand('remotish.gitHttp.configure');
  const adapter = await provider.createAdapter({ url: URL });
  await assert.rejects(adapter.getRepository(), (error) => error.code === 'UNAUTHORIZED');
  vscode.__test.inputBoxResponses.push(URL, 'Pilot Author', 'pilot@example.invalid', secondPairing);
  await vscode.commands.executeCommand('remotish.gitHttp.configure');
  key = await importKey(secondPairing);
  generation = 'second';
  await assert.rejects(adapter.getRepository(), (error) => error.code === 'UNAUTHORIZED');
  assert.deepEqual(requests, ['first', 'second']);
  assert.deepEqual(errors, []);
});

test('desktop transport confines bearer authorization and rejects redirects', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    const response = new Response(Uint8Array.of(0, 255), {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
    });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  try {
    const input = {
      url: `${URL}/git-upload-pack`,
      method: 'POST',
      headers: { Accept: 'application/x-git-upload-pack-result' },
      body: Uint8Array.of(1),
    };
    const result = await desktopGitRequest(URL, 'secret', input);
    assert.deepEqual(result.body, Uint8Array.of(0, 255));
    assert.equal(requests[0].init.headers.Authorization, 'Bearer secret');
    assert.equal(requests[0].init.redirect, 'error');
    await assert.rejects(
      desktopGitRequest(URL, 'secret', {
        ...input,
        url: 'https://other.example.invalid/repo.git/git-upload-pack',
      }),
      /origin/,
    );
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
