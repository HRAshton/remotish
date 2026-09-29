import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
const manifest = JSON.parse(
  await readFile(new URL('../../extensions/github-provider/package.json', import.meta.url)),
);
const workflow = await readFile(
  new URL('../../.github/workflows/release.yml', import.meta.url),
  'utf8',
);
const readme = await readFile(
  new URL('../../extensions/github-provider/README.md', import.meta.url),
  'utf8',
);
const license = await readFile(
  new URL('../../extensions/github-provider/LICENSE', import.meta.url),
  'utf8',
);
const ignore = await readFile(
  new URL('../../extensions/github-provider/.vscodeignore', import.meta.url),
  'utf8',
);

test('GitHub provider is a browser-only anonymous public repository extension', () => {
  assert.equal(manifest.browser, './dist/extension.js');
  assert.equal(manifest.main, undefined);
  assert.equal(manifest.private, true);
  assert.equal(manifest.publisher, 'hrashton');
  assert.deepEqual(manifest.extensionDependencies, ['hrashton.remotish']);
  assert.deepEqual(manifest.categories, ['SCM Providers', 'Other']);
  assert.ok(manifest.keywords.includes('github'));
  assert.ok(manifest.keywords.includes('open vsx'));
  assert.deepEqual(manifest.activationEvents, ['onFileSystem:remotish-github']);
  assert.deepEqual(manifest.capabilities.untrustedWorkspaces, { supported: true });
  assert.deepEqual(manifest.remotish, {
    provider: true,
    apiVersion: 1,
    id: 'github',
    displayName: 'GitHub',
  });
  assert.deepEqual(manifest.dependencies, {
    '@remotish/adapter-github': 'workspace:*',
    '@remotish/adapter-sdk': 'workspace:*',
  });
  assert.match(license, /^Zero-Clause BSD$/mu);
  assert.match(readme, /without authentication/u);
  assert.match(readme, /remotish-github:\/\/open\/v1\/<owner>\/<repository>/u);
  for (const rule of ['src/**', 'build/**', 'tsconfig.json']) {
    assert.ok(ignore.split(/\r?\n/u).includes(rule));
  }
});

test('GitHub provider VSIX participates in packaged smoke and release controls', () => {
  assert.match(root.scripts['release:github-provider:vsix'], /remotish-github-provider\.vsix$/u);
  assert.match(
    root.scripts['test:vscode-web'],
    /remotish-github:\/\/open\/v1\/octocat\/Hello-World/u,
  );
  assert.match(root.scripts['test:vscode-web:vsix'], /release:github-provider:vsix/u);
  assert.match(root.scripts['test:vscode-web:vsix'], /github-bootstrap\.js/u);
  assert.match(root.scripts['prepare:vscode-web-vsix'], /remotish-github-provider\.vsix/u);
  assert.match(workflow, /github_provider_version=/u);
  assert.match(workflow, /test "\$github_provider_version" = "\$version"/u);
  assert.match(workflow, /sha256sum[\s\S]*remotish-github-provider\.vsix/u);
  assert.match(
    workflow,
    /Attest build provenance[\s\S]*artifacts\/remotish-github-provider\.vsix/u,
  );
  assert.match(workflow, /gh release create[\s\S]*artifacts\/remotish-github-provider\.vsix/u);
  assert.match(workflow, /open-vsx-publish:/u);
  assert.match(workflow, /environment: open-vsx/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /npm install --global --ignore-scripts ovsx@1\.2\.0/u);
  assert.match(workflow, /ovsx publish artifacts\/remotish\.vsix --trusted-publishing/u);
  assert.match(
    workflow,
    /ovsx publish artifacts\/remotish-github-provider\.vsix --trusted-publishing/u,
  );
  assert.match(workflow, /ovsx get hrashton\.remotish --versionRange/u);
  assert.match(workflow, /ovsx get hrashton\.remotish-github-provider --versionRange/u);
  assert.match(workflow, /remotish-github:\/\/open\/v1\/octocat\/Hello-World/u);
  assert.doesNotMatch(workflow, /OVSX_PAT/u);
});
