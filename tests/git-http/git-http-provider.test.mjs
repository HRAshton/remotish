import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import * as vscode from 'vscode';
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
