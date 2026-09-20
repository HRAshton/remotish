import assert from 'node:assert/strict';
import test from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import { RemotishError } from '@remotish/adapter-sdk';
import { RemotishWorkspace } from '@remotish/core';
import {
  parseRepositoryUri,
  RepositoryFileSystem,
  revisionUriParts,
  WorkspaceRegistry,
  workingUriParts,
} from '@remotish/vscode/model';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function uri(parts) {
  return { query: '', ...parts };
}

test('vscode filesystem model: working and revision views are separated', async () => {
  const adapter = new FixtureAdapter();
  const workspace = await RemotishWorkspace.open(adapter);
  const registry = new WorkspaceRegistry();
  registry.register('fixture-demo', workspace);
  const fs = new RepositoryFileSystem(registry);

  const working = uri(workingUriParts('fixture-demo', 'README.md'));
  const pinnedBase = uri(revisionUriParts('fixture-demo', 'C3', 'README.md'));
  const original = decoder.decode(await fs.readFile(pinnedBase));

  await fs.writeFile(working, encoder.encode('working copy\n'), { create: false, overwrite: true });
  assert.equal(decoder.decode(await fs.readFile(working)), 'working copy\n');
  assert.equal(decoder.decode(await fs.readFile(pinnedBase)), original);

  const result = await workspace.commitAndPush('Publish working copy');
  assert.equal(result.status, 'success');
  if (result.status !== 'success') {
    return;
  }

  assert.equal(decoder.decode(await fs.readFile(pinnedBase)), original);
  const newRevision = uri(revisionUriParts('fixture-demo', result.revision, 'README.md'));
  assert.equal(decoder.decode(await fs.readFile(newRevision)), 'working copy\n');
});

test('vscode filesystem model: revision resources are immutable', async () => {
  const workspace = await RemotishWorkspace.open(new FixtureAdapter());
  const registry = new WorkspaceRegistry();
  registry.register('fixture-demo', workspace);
  const fs = new RepositoryFileSystem(registry);
  const base = uri(revisionUriParts('fixture-demo', workspace.baseRevision, 'README.md'));

  await assert.rejects(
    fs.writeFile(base, encoder.encode('nope'), { create: false, overwrite: true }),
    (error) => error instanceof RemotishError && error.code === 'FORBIDDEN',
  );
  assert.equal(await fs.isReadonly(base), true);
});

test('vscode filesystem model: URI parsing requires a pinned revision for base resources', () => {
  assert.deepEqual(parseRepositoryUri(uri(workingUriParts('fixture-demo', 'src/index.ts'))), {
    view: 'working',
    workspaceId: 'fixture-demo',
    path: 'src/index.ts',
  });
  assert.throws(() =>
    parseRepositoryUri({
      scheme: 'remotish-base',
      authority: 'fixture-demo',
      path: '/README.md',
      query: '',
    }),
  );
});

test('vscode filesystem model: workspace root URI has an explicit root path', () => {
  assert.deepEqual(workingUriParts('fixture-demo'), {
    scheme: 'remotish',
    authority: 'fixture-demo',
    path: '/',
  });
  assert.equal(workingUriParts('fixture-demo', 'README.md').path, '/README.md');
});

test('vscode filesystem model: URI paths use the same repository path validation as core', () => {
  assert.throws(() =>
    parseRepositoryUri({
      scheme: 'remotish',
      authority: 'fixture-demo',
      path: '/src/../README.md',
      query: '',
    }),
  );
  assert.throws(() => workingUriParts('fixture-demo', 'src//index.ts'));
  assert.equal(workingUriParts('fixture-demo', 'src\\index.ts').path, '/src/index.ts');
});


test('vscode filesystem model: cold read waits for workspace restoration', async () => {
  const workspace = await RemotishWorkspace.open(new FixtureAdapter());
  let registry;
  registry = new WorkspaceRegistry({
    defaultRestoreTimeoutMs: 1_000,
    restoreWorkspace: async (workspaceId) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      registry.register(workspaceId, workspace);
    },
  });
  const fs = new RepositoryFileSystem(registry);

  const content = await fs.readFile(uri(workingUriParts('cold-fixture', 'README.md')));
  assert.match(decoder.decode(content), /Fixture repository/u);
});

test('vscode filesystem model: failed restoration can be retried', async () => {
  const workspace = await RemotishWorkspace.open(new FixtureAdapter());
  let restoreAttempts = 0;
  let registry;
  registry = new WorkspaceRegistry({
    defaultRestoreTimeoutMs: 1_000,
    restoreWorkspace: async (workspaceId) => {
      restoreAttempts += 1;
      if (restoreAttempts === 1) {
        throw new RemotishError('UNAUTHORIZED', 'Authentication cancelled.');
      }
      registry.register(workspaceId, workspace);
    },
  });
  const fs = new RepositoryFileSystem(registry);
  const target = uri(workingUriParts('retry-fixture', 'README.md'));

  await assert.rejects(fs.readFile(target), { name: 'RemotishError', code: 'UNAUTHORIZED' });
  assert.match(decoder.decode(await fs.readFile(target)), /Fixture repository/u);
  assert.equal(restoreAttempts, 2);
});
