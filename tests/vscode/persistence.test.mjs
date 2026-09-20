import assert from 'node:assert/strict';
import test from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import { MemoryWorkspaceStorage, RemotishWorkspace } from '@remotish/core';
import { decodeWorkspaceSnapshot, encodeWorkspaceSnapshot } from '@remotish/vscode/model';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test('vscode persistence codec: binary overlays round-trip as JSON-safe base64', async () => {
  const storage = new MemoryWorkspaceStorage();
  const workspace = await RemotishWorkspace.open(new FixtureAdapter(), storage);
  const binary = new Uint8Array([0, 1, 2, 127, 128, 255]);
  await workspace.writeFile('binary.bin', binary, { create: true, overwrite: false });
  await workspace.writeFile('README.md', encoder.encode('persisted\n'), {
    create: false,
    overwrite: true,
  });
  await workspace.persist();

  const snapshot = await storage.load(workspace.repositoryInfo.id);
  assert.ok(snapshot);
  const encoded = encodeWorkspaceSnapshot(snapshot);
  const json = JSON.stringify(encoded);
  assert.equal(json.includes('contentBase64'), true);
  const decoded = decodeWorkspaceSnapshot(JSON.parse(json));

  const restoredStorage = new MemoryWorkspaceStorage();
  await restoredStorage.save(workspace.repositoryInfo.id, decoded);
  const restored = await RemotishWorkspace.open(new FixtureAdapter(), restoredStorage);
  assert.deepEqual(await restored.readFile('binary.bin'), binary);
  assert.equal(decoder.decode(await restored.readFile('README.md')), 'persisted\n');
});

test('vscode persistence codec: preserves publication phases and upgrades legacy journals', () => {
  const emptyOverlay = { files: [], directories: [], deletedPaths: [], renames: [] };
  const published = {
    version: 1,
    selectedBranch: 'main',
    branches: { main: { baseRevision: 'C3', overlay: emptyOverlay } },
    pendingCommitPublication: {
      phase: 'published',
      branch: 'main',
      expectedRemoteRevision: 'C3',
      publishedRevision: 'C4',
    },
  };
  assert.deepEqual(
    decodeWorkspaceSnapshot(encodeWorkspaceSnapshot(published)).pendingCommitPublication,
    published.pendingCommitPublication,
  );

  const legacy = decodeWorkspaceSnapshot({
    version: 1,
    selectedBranch: 'main',
    branches: { main: { baseRevision: 'C3', overlay: emptyOverlay } },
    pendingCommitPublication: { branch: 'main', expectedRemoteRevision: 'C3' },
  });
  assert.deepEqual(legacy.pendingCommitPublication, {
    phase: 'prepared',
    branch: 'main',
    expectedRemoteRevision: 'C3',
  });
});

test('vscode persistence codec: rejects malformed persisted state before decoding', () => {
  assert.throws(
    () =>
      decodeWorkspaceSnapshot({
        version: 1,
        selectedBranch: 'main',
        branches: {
          main: {
            baseRevision: 'C3',
            overlay: { files: 'not-an-array', directories: [], deletedPaths: [], renames: [] },
          },
        },
      }),
    /Invalid persisted Remotish workspace.*files must be an array/u,
  );

  assert.throws(
    () => decodeWorkspaceSnapshot({ version: 1, selectedBranch: 'main', branches: {} }),
    /selected branch main is not present/u,
  );
});
