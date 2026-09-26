import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
const manifest = JSON.parse(
  await readFile(new URL('../../extensions/git-http-provider/package.json', import.meta.url)),
);
const workflow = await readFile(
  new URL('../../.github/workflows/release.yml', import.meta.url),
  'utf8',
);
const readme = await readFile(
  new URL('../../extensions/git-http-provider/README.md', import.meta.url),
  'utf8',
);
const license = await readFile(
  new URL('../../extensions/git-http-provider/LICENSE', import.meta.url),
  'utf8',
);
const ignore = await readFile(
  new URL('../../extensions/git-http-provider/.vscodeignore', import.meta.url),
  'utf8',
);

test('Git HTTP provider is a supported packaged Web and desktop extension', () => {
  assert.equal(manifest.browser, './dist/extension.js');
  assert.equal(manifest.main, './dist/extension-desktop.js');
  assert.equal(manifest.private, true);
  assert.equal(manifest.publisher, 'hrashton');
  assert.deepEqual(manifest.remotish, {
    provider: true,
    apiVersion: 1,
    id: 'git-http',
    displayName: 'Git HTTP',
  });
  assert.deepEqual(manifest.capabilities.untrustedWorkspaces, {
    supported: false,
    description: 'Git HTTP uses credentials and a configured remote origin.',
  });
  assert.match(license, /^0BSD License$/mu);
  assert.doesNotMatch(readme, /\bpilot\b/iu);
  for (const rule of ['src/**', 'build/**', 'userscript-template/**', 'local/**']) {
    assert.ok(ignore.split(/\r?\n/u).includes(rule));
  }
});

test('Git HTTP VSIX participates in packaged smoke and release controls', () => {
  assert.match(
    root.scripts['release:git-http-provider:vsix'],
    /remotish-git-http-provider\.vsix$/u,
  );
  assert.match(root.scripts['test:vscode-web:vsix'], /release:git-http-provider:vsix/u);
  assert.match(root.scripts['prepare:vscode-web-vsix'], /remotish-git-http-provider\.vsix$/u);
  assert.match(workflow, /git_http_provider_version=/u);
  assert.match(workflow, /test "\$git_http_provider_version" = "\$version"/u);
  assert.match(workflow, /sha256sum[\s\S]*remotish-git-http-provider\.vsix/u);
  assert.match(
    workflow,
    /Attest build provenance[\s\S]*artifacts\/remotish-git-http-provider\.vsix/u,
  );
  assert.match(workflow, /gh release create[\s\S]*artifacts\/remotish-git-http-provider\.vsix/u);
});
