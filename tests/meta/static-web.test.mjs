import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const rootManifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
const registry = JSON.parse(await readFile(new URL('../../site/examples.json', import.meta.url)));
const workflow = await readFile(
  new URL('../../.github/workflows/pages.yml', import.meta.url),
  'utf8',
);
const assembler = await readFile(
  new URL('../../scripts/prepare-static-web.mjs', import.meta.url),
  'utf8',
);

test('static web registry is explicit about live, setup and source-only examples', () => {
  assert.equal(registry.schemaVersion, 1);
  assert.ok(Array.isArray(registry.examples));
  assert.ok(registry.examples.length >= 4);

  const ids = new Set();
  const allowedKinds = new Set(['live', 'setup', 'source']);
  const browserProviders = new Set(['fixture-provider', 'browser-rpc', 'git-http']);

  for (const example of registry.examples) {
    assert.match(example.id, /^[a-z0-9-]+$/u);
    assert.equal(ids.has(example.id), false, `duplicate example id: ${example.id}`);
    ids.add(example.id);
    assert.equal(allowedKinds.has(example.kind), true, `${example.id}: unsupported kind`);
    assert.match(example.docs, /^https:\/\/github\.com\/HRAshton\/remotish\//u);

    if (example.kind === 'source') {
      assert.equal(example.launch, undefined);
      assert.equal(example.provider, undefined);
    } else {
      assert.equal(browserProviders.has(example.provider), true, `${example.id}: unknown provider`);
      assert.equal(example.launch, 'workbench/');
      assert.equal(typeof example.command, 'string');
    }

    const serialized = JSON.stringify(example);
    assert.doesNotMatch(serialized, /clientSecret|accessToken|privateKey|password/iu);
  }
});

test('static web deployment stays aligned with the pinned VS Code and pnpm versions', () => {
  const vscodeVersion = rootManifest.devDependencies?.['@types/vscode'];
  const pnpmVersion = rootManifest.packageManager?.replace(/^pnpm@/u, '');

  assert.match(vscodeVersion ?? '', /^\d+\.\d+\.\d+$/u);
  assert.match(pnpmVersion ?? '', /^\d+\.\d+\.\d+$/u);
  assert.match(workflow, new RegExp(`^  VSCODE_VERSION: ${vscodeVersion}$`, 'mu'));
  assert.match(workflow, new RegExp(`^          version: ${pnpmVersion}$`, 'mu'));
  assert.match(workflow, /npm run gulp vscode-web-min/u);
  assert.match(workflow, /pnpm bundle:web-static:extensions/u);
  assert.match(workflow, /pnpm prepare:web-static/u);
  assert.match(workflow, /actions\/upload-pages-artifact@[0-9a-f]{40}/u);
  assert.match(workflow, /actions\/deploy-pages@[0-9a-f]{40}/u);
});

test('static workbench uses relative assets and bundles only browser extension outputs', () => {
  for (const extensionPath of [
    'apps/demo-web',
    'extensions/fixture-provider',
    'extensions/browser-rpc-provider',
    'extensions/git-http-provider',
  ]) {
    assert.equal(assembler.includes(extensionPath), true, `${extensionPath} is not copied`);
  }

  assert.match(assembler, /workbench\/workbench\.js/u);
  assert.match(assembler, /additionalBuiltinExtensions/u);
  assert.match(assembler, /extensionEnabledApiProposals/u);
  assert.doesNotMatch(assembler, /https?:\/\/(?:localhost|127\.0\.0\.1)/u);
});
