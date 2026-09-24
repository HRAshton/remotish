import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
const manifest = JSON.parse(
  await readFile(new URL('../../extensions/browser-rpc-provider/package.json', import.meta.url)),
);
const workflow = await readFile(
  new URL('../../.github/workflows/release.yml', import.meta.url),
  'utf8',
);
const license = await readFile(
  new URL('../../extensions/browser-rpc-provider/LICENSE', import.meta.url),
  'utf8',
);
const ignore = await readFile(
  new URL('../../extensions/browser-rpc-provider/.vscodeignore', import.meta.url),
  'utf8',
);

test('Browser RPC provider is a licensed, browser-only packaged extension', () => {
  assert.equal(manifest.browser, './dist/extension.js');
  assert.equal(manifest.main, undefined);
  assert.equal(manifest.private, true);
  assert.equal(manifest.publisher, 'hrashton');
  assert.ok(manifest.activationEvents.includes('onFileSystem:remotish-rpc'));
  assert.deepEqual(manifest.capabilities.untrustedWorkspaces, {
    supported: false,
    description:
      'Browser RPC can connect to authenticated remote endpoints selected by a repository request.',
  });
  assert.match(license, /^Zero-Clause BSD$/mu);
  for (const rule of ['src/**', 'build/**', 'userscript-template/**']) {
    assert.ok(ignore.split(/\r?\n/u).includes(rule));
  }
});

test('Browser RPC VSIX participates in packaged smoke and release controls', () => {
  assert.match(
    root.scripts['release:browser-rpc-provider:vsix'],
    /remotish-browser-rpc-provider\.vsix$/u,
  );
  assert.match(root.scripts['test:vscode-web:vsix'], /release:browser-rpc-provider:vsix/u);
  assert.match(root.scripts['prepare:vscode-web-vsix'], /remotish-browser-rpc-provider\.vsix$/u);
  assert.match(workflow, /browser_rpc_provider_version=/u);
  assert.match(workflow, /test "\$browser_rpc_provider_version" = "\$version"/u);
  assert.match(workflow, /sha256sum[\s\S]*remotish-browser-rpc-provider\.vsix/u);
  assert.match(
    workflow,
    /Attest build provenance[\s\S]*artifacts\/remotish-browser-rpc-provider\.vsix/u,
  );
  assert.match(workflow, /gh release create[\s\S]*artifacts\/remotish-browser-rpc-provider\.vsix/u);
});
