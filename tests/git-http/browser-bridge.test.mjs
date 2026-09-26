import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, webcrypto } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  decodeBytes,
  decrypt,
  encodeBytes,
  encrypt,
  importKey,
  MAX_BODY_BYTES,
} from '../../extensions/git-http-provider/build/bridge-wire.js';
import { GitHttpWebBridge } from '../../extensions/git-http-provider/build/web-bridge.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const gitUrl = 'https://git.example.com/scm/PRJ/repo.git';
const probeUrl = 'https://code.example.com/remotish-git-redirect-probe';

test('Web bridge carries the full documented body limit', async () => {
  const key = await importKey(randomBytes(32).toString('base64url'));
  const body = new Uint8Array(MAX_BODY_BYTES);
  body[body.length - 1] = 255;
  const packet = await encrypt(key, {
    version: 1,
    kind: 'response',
    hostId: 'a'.repeat(32),
    id: 'b'.repeat(32),
    status: 200,
    headers: {},
    body: encodeBytes(body),
  });
  const frame = await decrypt(key, packet);
  assert.equal(frame.kind, 'response');
  assert.deepEqual(decodeBytes(frame.body), body);
});

class Channel {
  static peers = new Set();
  onmessage = null;
  constructor(name) {
    this.name = name;
    Channel.peers.add(this);
  }
  postMessage(data) {
    for (const peer of Channel.peers) {
      if (peer !== this && peer.name === this.name) {
        queueMicrotask(() => peer.onmessage?.({ data }));
      }
    }
  }
  close() {
    Channel.peers.delete(this);
  }
}

async function bundle(t, pairing) {
  const local = join(root, 'extensions/git-http-provider/local');
  await mkdir(local, { recursive: true });
  const directory = await mkdtemp(join(local, 'test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const template = await readFile(
    new URL('../../extensions/git-http-provider/userscript-template/entry.ts', import.meta.url),
    'utf8',
  );
  const metadata = await readFile(
    new URL('../../extensions/git-http-provider/userscript-template/metadata.txt', import.meta.url),
    'utf8',
  );
  const entryFile = join(directory, 'entry.ts');
  const metadataFile = join(directory, 'metadata.txt');
  const outputFile = join(directory, 'pilot.user.js');
  await writeFile(
    entryFile,
    template
      .replace('../src/bridge-wire.js', '../../src/bridge-wire.js')
      .replaceAll('https://code.example.invalid', 'https://code.example.com')
      .replaceAll('https://git.example.invalid', 'https://git.example.com')
      .replace('REPLACE_WITH_YOUR_OWN_43_CHARACTER_BASE64URL_KEY', pairing),
  );
  await writeFile(
    metadataFile,
    metadata
      .replaceAll('code.example.invalid', 'code.example.com')
      .replaceAll('git.example.invalid', 'git.example.com')
      .replaceAll('https://example.invalid', 'https://code.example.com'),
  );
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts/build-git-http-userscript.mjs'), entryFile, metadataFile, outputFile],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return readFile(outputFile, 'utf8');
}

function runUserscript(script, xhr) {
  const errors = [];
  vm.runInNewContext(script, {
    location: { origin: 'https://code.example.com' },
    GM_info: { sandboxMode: 'dom', scriptHandler: 'Tampermonkey' },
    GM_getValue: () => 'pilot-token',
    GM_setValue: () => {},
    GM_registerMenuCommand: () => {},
    GM_xmlhttpRequest: xhr,
    BroadcastChannel: Channel,
    crypto: webcrypto,
    URL,
    ArrayBuffer,
    Uint8Array,
    TextEncoder,
    TextDecoder,
    btoa,
    atob,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    addEventListener: () => {},
    console: { error: (message) => errors.push(message) },
  });
  return errors;
}

test('Web bridge proves redirect control before use and confines bearer requests', async (t) => {
  const pairing = randomBytes(32).toString('base64url');
  const script = await bundle(t, pairing);
  const original = globalThis.BroadcastChannel;
  globalThis.BroadcastChannel = Channel;
  t.after(() => {
    globalThis.BroadcastChannel = original;
    for (const peer of Channel.peers) {
      peer.close();
    }
  });

  const failedProbe = [];
  const successErrors = runUserscript(script, (details) => {
    failedProbe.push(details);
    queueMicrotask(() =>
      details.onload({
        status: 200,
        finalUrl: 'https://code.example.com/followed',
        response: new ArrayBuffer(0),
        responseHeaders: '',
      }),
    );
    return { abort() {} };
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(failedProbe.length, 1);
  assert.equal(failedProbe[0].redirect, 'manual');
  assert.equal(failedProbe[0].anonymous, true);
  assert.equal(failedProbe[0].headers, undefined);
  assert.equal(Channel.peers.size, 0);

  const requests = [];
  let aborted = 0;
  let nextResponse = 'success';
  runUserscript(script, (details) => {
    requests.push(details);
    if (details.url === probeUrl) {
      queueMicrotask(() =>
        details.onload({
          status: 302,
          finalUrl: probeUrl,
          response: new ArrayBuffer(0),
          responseHeaders: 'Location: /other\r\n',
        }),
      );
    } else if (nextResponse === 'success') {
      queueMicrotask(() =>
        details.onload({
          status: 200,
          finalUrl: details.url,
          response: Uint8Array.of(0, 255).buffer,
          responseHeaders: 'Content-Type: application/x-git-upload-pack-result\r\n',
        }),
      );
    } else if (nextResponse === 'redirect') {
      queueMicrotask(() =>
        details.onload({
          status: 302,
          finalUrl: details.url,
          response: new ArrayBuffer(0),
          responseHeaders: 'Location: https://elsewhere.example/\r\n',
        }),
      );
    }
    return {
      abort() {
        aborted += 1;
        details.onabort();
      },
    };
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(Channel.peers.size, 1, successErrors.join('; '));
  const bridge = await GitHttpWebBridge.connect(pairing, gitUrl);
  t.after(() => bridge.dispose());
  const input = {
    url: `${gitUrl}/info/refs?service=git-upload-pack`,
    method: 'GET',
    headers: { Accept: 'application/x-git-upload-pack-advertisement' },
    body: new Uint8Array(),
  };
  const response = await bridge.request(input);
  assert.deepEqual(response.body, Uint8Array.of(0, 255));
  assert.equal(requests.at(-1).headers.Authorization, 'Bearer pilot-token');
  assert.equal(requests.at(-1).redirect, 'manual');
  assert.equal(requests.at(-1).url, input.url);

  await assert.rejects(
    bridge.request({ ...input, url: 'https://other.example/repo.git/info/refs' }),
    /origin/,
  );
  await assert.rejects(
    bridge.request({ ...input, body: new Uint8Array(4 * 1024 * 1024 + 1) }),
    /too large/,
  );
  assert.equal(requests.length, 2);

  nextResponse = 'redirect';
  await assert.rejects(bridge.request(input), (error) => error.code === 'OFFLINE');
  nextResponse = 'pending';
  const controller = new AbortController();
  const pending = bridge.request({ ...input, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'CANCELLED');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(aborted, 1);
});
