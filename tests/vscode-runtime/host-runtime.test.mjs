import assert from 'node:assert/strict';
import test from 'node:test';
import * as vscode from 'vscode';
import { activate } from '../../apps/demo-web/build/extension.js';
import {
  FIXTURE_WORKSPACE_ID,
  installFixtureProvider,
  prepareFixtureRepository,
} from './fixture-provider-extension.mjs';

function createMemento() {
  const values = new Map();
  return {
    get(key, defaultValue) {
      return values.has(key) ? values.get(key) : defaultValue;
    },
    async update(key, value) {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    },
  };
}

async function activateDemo(t) {
  vscode.__test.reset();
  const fixtureProvider = installFixtureProvider();
  const context = {
    workspaceState: createMemento(),
    globalState: createMemento(),
    storageUri: vscode.Uri.from({
      scheme: 'test-storage',
      authority: 'workspace',
      path: '/remotish',
    }),
    globalStorageUri: vscode.Uri.from({
      scheme: 'test-storage',
      authority: 'global',
      path: '/remotish',
    }),
    subscriptions: [],
  };
  await activate(context);
  await prepareFixtureRepository();
  t.after(() => {
    for (const disposable of [...context.subscriptions].reverse()) {
      disposable.dispose();
    }
    fixtureProvider.dispose();
    vscode.__test.reset();
  });
  await settle();
  return context;
}

function scmGroup(sourceControl, id) {
  const group = sourceControl.__groups.find((candidate) => candidate.id === id);
  assert.ok(group, `Missing SCM group ${id}`);
  return group;
}

test('vscode runtime: demo wires VFS, SCM, branch status and native history provider', async (t) => {
  await activateDemo(t);
  assert.deepEqual([...vscode.__test.fileSystemProviders.keys()].sort(), [
    'remotish',
    'remotish-base',
  ]);
  assert.equal(vscode.__test.sourceControls.length, 1);

  const sourceControl = vscode.__test.sourceControls[0];
  assert.equal(sourceControl.id, 'remotish');
  assert.equal(sourceControl.actionButton.command.command, 'remotish.commitAndPush');
  assert.equal(sourceControl.actionButton.secondaryCommands.length, 3);
  assert.deepEqual(
    sourceControl.__groups.map((group) => group.id),
    ['staged', 'changes'],
  );
  assert.ok(sourceControl.historyProvider);
  assert.equal(sourceControl.historyProvider.currentHistoryItemRef.revision, 'C3');
  assert.equal(vscode.__test.statusBarItems[0]?.text, '$(git-branch) main');

  await vscode.commands.executeCommand('remotish.demo.openFixture');
  const opened = vscode.__test.externalCommands.find(
    (item) => item.command === 'vscode.openFolder',
  );
  assert.equal(opened?.args[0].toString(), `remotish://${FIXTURE_WORKSPACE_ID}/`);
});

test('vscode runtime: Timeline shows repository commits for the active file', async (t) => {
  await activateDemo(t);
  assert.equal(vscode.__test.timelineProviders.length, 1);

  const registration = vscode.__test.timelineProviders[0];
  assert.equal(registration.scheme, 'remotish');
  assert.equal(registration.provider.id, 'remotish');

  const readme = vscode.Uri.from({
    scheme: 'remotish',
    authority: FIXTURE_WORKSPACE_ID,
    path: '/README.md',
  });
  const timeline = await registration.provider.provideTimeline(
    readme,
    { limit: 10 },
    cancellationToken(),
  );

  assert.deepEqual(
    timeline.items.map((item) => item.id),
    ['C3', 'C1'],
  );
  assert.ok(timeline.items.every((item) => item.timestamp > 0));
  assert.equal(timeline.items[0]?.command?.command, 'vscode.diff');
  assert.equal(
    timeline.items[0]?.command?.arguments?.[0].toString(),
    `remotish-base://${FIXTURE_WORKSPACE_ID}/README.md?revision=C2`,
  );
  assert.equal(
    timeline.items[0]?.command?.arguments?.[1].toString(),
    `remotish-base://${FIXTURE_WORKSPACE_ID}/README.md?revision=C3`,
  );
  assert.equal(timeline.items[1]?.command?.command, 'vscode.open');
});

test('vscode runtime: VFS stats use real session timestamps instead of the Unix epoch', async (t) => {
  await activateDemo(t);
  const provider = vscode.__test.fileSystemProviders.get('remotish').provider;
  const readme = vscode.Uri.from({
    scheme: 'remotish',
    authority: FIXTURE_WORKSPACE_ID,
    path: '/README.md',
  });

  const initial = await provider.stat(readme);
  assert.ok(initial.ctime > 0);
  assert.ok(initial.mtime > 0);

  await provider.writeFile(readme, new TextEncoder().encode('# Timestamped edit\n'), {
    create: false,
    overwrite: true,
  });
  const edited = await provider.stat(readme);
  assert.ok(edited.ctime > 0);
  assert.ok(edited.mtime > 0);
});

test('vscode runtime: working edit can be opened, staged, reverted, and published', async (t) => {
  await activateDemo(t);
  const sourceControl = vscode.__test.sourceControls[0];
  const staged = scmGroup(sourceControl, 'staged');
  const changes = scmGroup(sourceControl, 'changes');
  const provider = vscode.__test.fileSystemProviders.get('remotish').provider;
  const readme = vscode.Uri.from({
    scheme: 'remotish',
    authority: FIXTURE_WORKSPACE_ID,
    path: '/README.md',
  });

  await provider.writeFile(readme, new TextEncoder().encode('# Runtime edit\n'), {
    create: false,
    overwrite: true,
  });
  await settle();
  assert.equal(changes.resourceStates.length, 1);
  assert.equal(staged.resourceStates.length, 0);

  const original = await sourceControl.quickDiffProvider.provideOriginalResource(
    readme,
    cancellationToken(),
  );
  assert.equal(original?.toString(), `remotish-base://${FIXTURE_WORKSPACE_ID}/README.md?revision=C3`);

  await vscode.commands.executeCommand('remotish.openFile', changes.resourceStates[0]);
  const opened = vscode.__test.externalCommands.find((item) => item.command === 'vscode.open');
  assert.equal(opened?.args[0].toString(), `remotish://${FIXTURE_WORKSPACE_ID}/README.md`);

  await vscode.commands.executeCommand('remotish.stage', changes.resourceStates[0]);
  assert.equal(staged.resourceStates.length, 1);
  assert.equal(changes.resourceStates.length, 0);

  await vscode.commands.executeCommand('remotish.unstage', staged.resourceStates[0]);
  assert.equal(staged.resourceStates.length, 0);
  assert.equal(changes.resourceStates.length, 1);

  vscode.__test.warningResponses.push('Revert');
  await vscode.commands.executeCommand('remotish.revert', changes.resourceStates[0]);
  await settle();
  assert.equal(changes.resourceStates.length, 0);

  await provider.writeFile(readme, new TextEncoder().encode('# Published runtime edit\n'), {
    create: false,
    overwrite: true,
  });
  await settle();
  await vscode.commands.executeCommand('remotish.stageAll', changes);
  sourceControl.inputBox.value = 'Runtime publish';
  const before = sourceControl.historyProvider.currentHistoryItemRef.revision;
  await vscode.commands.executeCommand('remotish.commitAndPush');
  await settle();

  assert.equal(staged.resourceStates.length, 0);
  assert.equal(changes.resourceStates.length, 0);
  assert.equal(sourceControl.inputBox.value, '');
  assert.notEqual(sourceControl.historyProvider.currentHistoryItemRef.revision, before);
  assert.ok(vscode.__test.infoMessages.some((message) => message.startsWith('Published ')));
});

test('vscode runtime: commit publishes only staged files and leaves other changes', async (t) => {
  await activateDemo(t);
  const sourceControl = vscode.__test.sourceControls[0];
  const staged = scmGroup(sourceControl, 'staged');
  const changes = scmGroup(sourceControl, 'changes');
  const provider = vscode.__test.fileSystemProviders.get('remotish').provider;
  const readme = vscode.Uri.from({
    scheme: 'remotish',
    authority: FIXTURE_WORKSPACE_ID,
    path: '/README.md',
  });
  const index = vscode.Uri.from({
    scheme: 'remotish',
    authority: FIXTURE_WORKSPACE_ID,
    path: '/src/index.ts',
  });

  await provider.writeFile(readme, new TextEncoder().encode('# Selected\n'), {
    create: false,
    overwrite: true,
  });
  await provider.writeFile(index, new TextEncoder().encode("export const greeting = 'later';\n"), {
    create: false,
    overwrite: true,
  });
  await settle();
  assert.equal(changes.resourceStates.length, 2);

  const readmeState = changes.resourceStates.find(
    (state) => state.resourceUri.path === '/README.md',
  );
  assert.ok(readmeState);
  await vscode.commands.executeCommand('remotish.stage', readmeState);
  assert.equal(staged.resourceStates.length, 1);
  assert.equal(changes.resourceStates.length, 1);

  sourceControl.inputBox.value = 'Publish selected file';
  await vscode.commands.executeCommand('remotish.commitAndPush', FIXTURE_WORKSPACE_ID);
  await settle();

  assert.equal(staged.resourceStates.length, 0);
  assert.equal(changes.resourceStates.length, 1);
  assert.equal(changes.resourceStates[0]?.resourceUri.path, '/src/index.ts');
  assert.equal(
    new TextDecoder().decode(await provider.readFile(index)),
    "export const greeting = 'later';\n",
  );
});

test('vscode runtime: branch picker switches the same registered workspace', async (t) => {
  await activateDemo(t);
  const sourceControl = vscode.__test.sourceControls[0];
  vscode.__test.quickPickResponses.push('feature/test');
  await vscode.commands.executeCommand('remotish.switchBranch');
  await settle();

  assert.equal(vscode.__test.statusBarItems[0]?.text, '$(git-branch) feature/test');
  assert.equal(sourceControl.historyProvider.currentHistoryItemRef.id, 'workspace:feature/test');
  assert.equal(sourceControl.historyProvider.currentHistoryItemRef.revision, 'F2');
  assert.equal(sourceControl.rootUri.toString(), `remotish://${FIXTURE_WORKSPACE_ID}/`);
});

test('vscode runtime: history changed-file resources stay revision pinned', async (t) => {
  await activateDemo(t);
  const provider = vscode.__test.sourceControls[0].historyProvider;
  const historyChanges = await provider.provideHistoryItemChanges('C3', 'C2', cancellationToken());
  const readme = historyChanges.find((change) => change.uri.path === '/README.md');
  assert.equal(readme?.originalUri?.query, 'revision=C2');
  assert.equal(readme?.modifiedUri?.query, 'revision=C3');
});

test('vscode runtime: rename is a framework working-tree operation and can be reverted', async (t) => {
  await activateDemo(t);
  const sourceControl = vscode.__test.sourceControls[0];
  const changes = scmGroup(sourceControl, 'changes');
  const provider = vscode.__test.fileSystemProviders.get('remotish').provider;
  const from = vscode.Uri.from({
    scheme: 'remotish',
    authority: FIXTURE_WORKSPACE_ID,
    path: '/README.md',
  });
  const to = vscode.Uri.from({
    scheme: 'remotish',
    authority: FIXTURE_WORKSPACE_ID,
    path: '/README-renamed.md',
  });

  await provider.rename(from, to, { overwrite: false });
  await settle();
  const renamed = changes.resourceStates.find(
    (state) => state.resourceUri.path === '/README-renamed.md',
  );
  assert.equal(renamed?.contextValue, 'remotish.renamed');

  vscode.__test.warningResponses.push('Revert');
  await vscode.commands.executeCommand('remotish.revert', renamed);
  await settle();
  assert.equal(changes.resourceStates.length, 0);
  assert.match(new TextDecoder().decode(await provider.readFile(from)), /Fixture repository/);
});

function cancellationToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested() {
      return { dispose() {} };
    },
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('vscode runtime: stale commit is preserved, force-with-lease publishes, and message-only amend rewrites', async (t) => {
  vscode.__test.reset();
  const { FixtureAdapter } = await import('@remotish/adapter-fixture');
  const { RemotishWorkspace } = await import('@remotish/core');
  const { RemotishVsCodeHost } = await import('@remotish/vscode');
  const { RemotishHistoryHost } = await import('@remotish/vscode-history');

  const adapter = new FixtureAdapter();
  const workspace = await RemotishWorkspace.open(adapter);
  const host = new RemotishVsCodeHost();
  const history = new RemotishHistoryHost(host);
  const unregister = host.registry.register('runtime-fixture', workspace);
  t.after(() => {
    unregister.dispose();
    history.dispose();
    host.dispose();
    vscode.__test.reset();
  });
  await settle();

  const sourceControl = vscode.__test.sourceControls[0];
  const staged = scmGroup(sourceControl, 'staged');
  const changes = scmGroup(sourceControl, 'changes');
  const provider = vscode.__test.fileSystemProviders.get('remotish').provider;
  const readme = vscode.Uri.from({
    scheme: 'remotish',
    authority: 'runtime-fixture',
    path: '/README.md',
  });
  await provider.writeFile(readme, new TextEncoder().encode('# Lease test\n'), {
    create: false,
    overwrite: true,
  });
  await settle();
  await vscode.commands.executeCommand('remotish.stageAll', changes);
  sourceControl.inputBox.value = 'Lease test';

  adapter.moveBranchHead('main', 'C2');
  await vscode.commands.executeCommand('remotish.commitAndPush', 'runtime-fixture');
  await settle();
  assert.equal(workspace.baseRevision, 'C3');
  assert.equal(staged.resourceStates.length, 1);
  assert.equal(sourceControl.inputBox.value, 'Lease test');
  assert.ok(
    vscode.__test.warningMessages.some((message) =>
      message.includes('Remote branch now points to C2'),
    ),
  );

  vscode.__test.warningResponses.push('Force Push');
  await vscode.commands.executeCommand('remotish.commitAndPushForceWithLease', 'runtime-fixture');
  await settle();
  const forcedRevision = workspace.baseRevision;
  assert.notEqual(forcedRevision, 'C3');
  assert.equal(adapter.getBranchHead('main'), forcedRevision);
  assert.equal(staged.resourceStates.length, 0);
  assert.equal(changes.resourceStates.length, 0);

  sourceControl.inputBox.value = '';
  vscode.__test.warningResponses.push('Amend & Push');
  await vscode.commands.executeCommand('remotish.amendAndPushForceWithLease', 'runtime-fixture');
  await settle();
  assert.notEqual(workspace.baseRevision, forcedRevision);
  assert.equal(adapter.getBranchHead('main'), workspace.baseRevision);
  assert.equal(staged.resourceStates.length, 0);
  assert.equal(changes.resourceStates.length, 0);
});
