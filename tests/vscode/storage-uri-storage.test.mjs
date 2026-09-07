import assert from 'node:assert/strict';
import test from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import { RemotishWorkspace } from '@remotish/core';
import { StorageUriWorkspaceStorage } from '@remotish/vscode';
import * as vscode from 'vscode';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test('vscode persistence: storageUri-backed storage restores workspace overlays', async () => {
  vscode.__test.reset();
  const root = vscode.Uri.from({ scheme: 'test-storage', authority: 'workspace', path: '/state' });
  const storage = new StorageUriWorkspaceStorage(root, 'round-trip');
  const adapter = new FixtureAdapter();
  const first = await RemotishWorkspace.open(adapter, storage);

  await first.writeFile('README.md', encoder.encode('stored outside Memento\n'), {
    create: false,
    overwrite: true,
  });

  const restored = await RemotishWorkspace.open(adapter, storage);
  assert.equal(decoder.decode(await restored.readFile('README.md')), 'stored outside Memento\n');
  vscode.__test.reset();
});

test('vscode persistence: storageUri uses raw content-addressed blobs instead of base64 snapshots', async () => {
  vscode.__test.reset();
  const root = vscode.Uri.from({ scheme: 'test-storage', authority: 'workspace', path: '/state' });
  const storage = new StorageUriWorkspaceStorage(root, 'blob-layout');
  const workspace = await RemotishWorkspace.open(new FixtureAdapter(), storage);
  const content = encoder.encode('binary-safe payload\n');

  await workspace.writeFile('README.md', content, { create: false, overwrite: true });

  const entries = [...vscode.__test.storageFiles.entries()];
  const pointerEntry = entries.find(([key]) => key.endsWith('/current.json'));
  assert.ok(pointerEntry);
  const pointer = JSON.parse(decoder.decode(pointerEntry[1]));
  const manifestEntry = entries.find(([key]) => key.endsWith(`/manifests/${pointer.current}.json`));
  assert.ok(manifestEntry);
  const manifestText = decoder.decode(manifestEntry[1]);
  assert.equal(manifestText.includes('contentBase64'), false);

  const blobEntries = entries.filter(([key]) => key.includes('/blobs/') && key.endsWith('.bin'));
  assert.equal(blobEntries.length, 1);
  assert.deepEqual(blobEntries[0][1], content);
  vscode.__test.reset();
});

test('vscode persistence: corrupt current generation falls back to the previous committed snapshot', async () => {
  vscode.__test.reset();
  const root = vscode.Uri.from({ scheme: 'test-storage', authority: 'workspace', path: '/state' });
  const adapter = new FixtureAdapter();
  const storage = new StorageUriWorkspaceStorage(root, 'recovery');
  const workspace = await RemotishWorkspace.open(adapter, storage);

  await workspace.writeFile('README.md', encoder.encode('previous generation\n'), {
    create: false,
    overwrite: true,
  });
  await workspace.writeFile('README.md', encoder.encode('current generation\n'), {
    create: false,
    overwrite: true,
  });

  const pointerEntry = [...vscode.__test.storageFiles.entries()].find(([key]) =>
    key.endsWith('/current.json'),
  );
  assert.ok(pointerEntry);
  const pointer = JSON.parse(decoder.decode(pointerEntry[1]));
  assert.ok(pointer.previous);
  const currentManifestKey = [...vscode.__test.storageFiles.keys()].find((key) =>
    key.endsWith(`/manifests/${pointer.current}.json`),
  );
  assert.ok(currentManifestKey);
  vscode.__test.storageFiles.set(currentManifestKey, encoder.encode('{"corrupt":true}'));

  const restartedStorage = new StorageUriWorkspaceStorage(root, 'recovery');
  const restored = await RemotishWorkspace.open(adapter, restartedStorage);
  assert.equal(decoder.decode(await restored.readFile('README.md')), 'previous generation\n');
  vscode.__test.reset();
});

test('vscode persistence: corrupt primary pointer recovers through its backup copy', async () => {
  vscode.__test.reset();
  const adapter = new FixtureAdapter();
  const root = vscode.Uri.from({ scheme: 'test-storage', authority: 'workspace', path: '/state' });
  const storage = new StorageUriWorkspaceStorage(root, 'pointer-recovery');
  const workspace = await RemotishWorkspace.open(adapter, storage);
  await workspace.writeFile('README.md', encoder.encode('pointer recovery\n'), {
    create: false,
    overwrite: true,
  });

  const pointerKey = [...vscode.__test.storageFiles.keys()].find(
    (key) => key.includes('pointer-recovery') && key.endsWith('/current.json'),
  );
  assert.ok(pointerKey);
  vscode.__test.storageFiles.set(pointerKey, encoder.encode('{broken'));

  const restartedStorage = new StorageUriWorkspaceStorage(root, 'pointer-recovery');
  const restored = await RemotishWorkspace.open(adapter, restartedStorage);
  assert.equal(decoder.decode(await restored.readFile('README.md')), 'pointer recovery\n');
  vscode.__test.reset();
});

test('vscode persistence: storageUri preserves prototype-named Git branches', async () => {
  for (const branch of ['__proto__', 'constructor', 'toString']) {
    vscode.__test.reset();
    const adapter = new FixtureAdapter();
    await adapter.createBranch(branch, 'C3');
    const root = vscode.Uri.from({
      scheme: 'test-storage',
      authority: 'workspace',
      path: `/prototype-${branch}`,
    });
    const storage = new StorageUriWorkspaceStorage(root, `prototype-${branch}`);
    const first = await RemotishWorkspace.open(adapter, storage);

    await first.switchBranch(branch);
    await first.writeFile('README.md', encoder.encode(`# ${branch}\n`), {
      create: false,
      overwrite: true,
    });

    const restored = await RemotishWorkspace.open(adapter, storage);
    assert.equal(restored.branch, branch);
    assert.equal(decoder.decode(await restored.readFile('README.md')), `# ${branch}\n`);
  }
  vscode.__test.reset();
});
