import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { BRANCH_COMMANDS } from '../../packages/vscode/dist/branches/commands.js';
import { SCM_COMMANDS } from '../../packages/vscode/dist/scm/source-control.js';
import { createOpenVsxHostManifest } from '../../scripts/prepare-open-vsx-host.mjs';

const manifest = JSON.parse(
  await readFile(new URL('../../apps/demo-web/package.json', import.meta.url)),
);
const hostSource = await readFile(
  new URL('../../apps/demo-web/src/extension.ts', import.meta.url),
  'utf8',
);
const stableManifest = JSON.parse(
  await readFile(new URL('../../apps/demo-web/src/test/stable/package.json', import.meta.url)),
);
const stableHostSource = await readFile(
  new URL('../../apps/demo-web/src/test/stable/extension.ts', import.meta.url),
  'utf8',
);
const releaseHostSource = await readFile(
  new URL('../../apps/demo-web/src/extension-stable.ts', import.meta.url),
  'utf8',
);
const openVsxReadme = await readFile(
  new URL('../../apps/demo-web/README.open-vsx.md', import.meta.url),
  'utf8',
);

test('host manifest is WebWorker-compatible and activates for provider commands', () => {
  assert.equal(Object.hasOwn(manifest, 'type'), false);
  const activationEvents = new Set(manifest.activationEvents ?? []);
  for (const command of [
    'remotish.ensureRepository',
    'remotish.openRepository',
    'remotish.selectPreparedBranch',
    'remotish.refreshProviders',
    'remotish.exportDiagnostics',
  ]) {
    assert.ok(activationEvents.has(`onCommand:${command}`), `Missing activation for ${command}`);
  }
});

test('host manifest contributes every public framework command', () => {
  const contributed = new Set(manifest.contributes.commands.map((command) => command.command));
  const expected = [
    ...Object.values(SCM_COMMANDS).filter((command) => command !== SCM_COMMANDS.openChange),
    ...Object.values(BRANCH_COMMANDS),
  ];

  for (const command of expected) {
    assert.ok(contributed.has(command), `Missing VS Code contribution for ${command}`);
  }

  assert.equal(contributed.has(SCM_COMMANDS.openChange), false);
  assert.equal(contributed.has('remotish.demo.openFixture'), false);
  assert.ok(contributed.has('remotish.ensureRepository'));
  assert.ok(contributed.has('remotish.openRepository'));
  assert.ok(contributed.has('remotish.selectPreparedBranch'));
  assert.ok(contributed.has('remotish.refreshProviders'));
  assert.ok(contributed.has('remotish.exportDiagnostics'));
});

test('host activation contains no fixture or demo special cases', () => {
  assert.doesNotMatch(hostSource, /adapter-fixture|FixtureAdapter|RemotishWorkspace/u);
  assert.doesNotMatch(hostSource, /fixture-demo|remotish\.demo\.openFixture/u);
});

test('host manifest has no fixture or core runtime dependency', () => {
  assert.equal(manifest.dependencies?.['@remotish/adapter-fixture'], undefined);
  assert.equal(manifest.dependencies?.['@remotish/core'], undefined);
  assert.deepEqual(manifest.dependencies, {
    '@remotish/vscode': 'workspace:*',
    '@remotish/vscode-history': 'workspace:*',
  });
});

test('internal diff command is not exposed as an SCM button or menu action', () => {
  for (const items of Object.values(manifest.contributes.menus ?? {})) {
    assert.equal(
      items.some((item) => item.command === SCM_COMMANDS.openChange),
      false,
    );
  }
});

test('revert is an inline action for files in the Changes group', () => {
  const resourceActions = manifest.contributes.menus?.['scm/resourceState/context'] ?? [];
  const revert = resourceActions.find((item) => item.command === SCM_COMMANDS.revert);

  assert.equal(revert?.group, 'inline@3');
  assert.equal(revert?.when, 'scmProvider == remotish && scmResourceGroup == changes');
});

test('controlled demo enables only the proposal-sensitive history APIs', () => {
  assert.deepEqual(manifest.enabledApiProposals, ['scmHistoryProvider', 'timeline']);
});

test('Open VSX host manifest strips proposed APIs from the controlled demo', () => {
  const published = createOpenVsxHostManifest(manifest);

  assert.equal(published.name, 'remotish');
  assert.equal(published.publisher, 'hrashton');
  assert.equal(published.version, manifest.version);
  assert.equal(published.enabledApiProposals, undefined);
  assert.deepEqual(published.dependencies, {
    '@remotish/vscode': 'workspace:*',
  });
  assert.deepEqual(published.categories, ['SCM Providers', 'Other']);
  assert.ok(published.keywords.includes('open vsx'));
  assert.match(releaseHostSource, /@remotish\/vscode/u);
  assert.doesNotMatch(releaseHostSource, /@remotish\/vscode-history|RemotishHistoryHost/u);
  assert.match(openVsxReadme, /hrashton\.remotish-github-provider/u);
  assert.match(openVsxReadme, /remotish-github:\/\/open\/v1\/octocat\/Hello-World/u);
});

test('stable smoke host uses the base package without proposed APIs', () => {
  assert.equal(stableManifest.enabledApiProposals, undefined);
  assert.equal(stableManifest.browser, './extension.js');
  assert.match(stableHostSource, /@remotish\/vscode/u);
  assert.doesNotMatch(stableHostSource, /@remotish\/vscode-history|RemotishHistoryHost/u);
});

test('every contributed menu command is declared', () => {
  const commands = new Set(manifest.contributes.commands.map((command) => command.command));
  for (const items of Object.values(manifest.contributes.menus ?? {})) {
    for (const item of items) {
      assert.ok(commands.has(item.command), `Menu references undeclared command ${item.command}`);
    }
  }
});

test('demo manifest formats Remotish workspace roots with their authority', () => {
  const formatters = manifest.contributes.resourceLabelFormatters ?? [];
  const working = formatters.find((formatter) => formatter.scheme === 'remotish');
  const revision = formatters.find((formatter) => formatter.scheme === 'remotish-base');

  assert.equal(working?.formatting.label, `\${authority}\${path}`);
  assert.equal(working?.formatting.stripPathStartingSeparator, undefined);
  assert.equal(revision?.formatting.label, `\${authority}\${path}`);
});

test('context-only SCM commands are hidden from the Command Palette', () => {
  const hidden = new Map(
    (manifest.contributes.menus?.commandPalette ?? []).map((item) => [item.command, item.when]),
  );
  for (const command of [
    'remotish.openFile',
    'remotish.stage',
    'remotish.unstage',
    'remotish.stageAll',
    'remotish.unstageAll',
    'remotish.revert',
    'remotish.revertAll',
    'remotish.ensureRepository',
    'remotish.openRepository',
    'remotish.selectPreparedBranch',
  ]) {
    assert.equal(hidden.get(command), 'false', `${command} should be context-only`);
  }
  assert.equal(hidden.has('remotish.refreshProviders'), false);
});
