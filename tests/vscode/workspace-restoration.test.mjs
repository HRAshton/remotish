import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FixtureAdapter } from '@remotish/adapter-fixture';
import { RemotishWorkspace } from '@remotish/core';
import { WorkspaceRegistry } from '@remotish/vscode/model';

test('workspace registry coalesces restoration attempts for concurrent waiters', async () => {
  const workspace = await RemotishWorkspace.open(new FixtureAdapter());
  let attempts = 0;
  let registry;
  registry = new WorkspaceRegistry({
    defaultRestoreTimeoutMs: 1_000,
    restoreWorkspace: async (workspaceId) => {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      registry.register(workspaceId, workspace);
    },
  });

  const [first, second] = await Promise.all([
    registry.waitFor('restore-fixture'),
    registry.waitFor('restore-fixture'),
  ]);

  assert.equal(attempts, 1);
  assert.equal(first, second);
  assert.equal(first.workspace, workspace);
});

test('workspace registry wait supports AbortSignal cancellation', async () => {
  const registry = new WorkspaceRegistry({ defaultRestoreTimeoutMs: 1_000 });
  const controller = new AbortController();
  const pending = registry.waitFor('cancel-fixture', { signal: controller.signal });
  controller.abort();

  await assert.rejects(pending, { name: 'RemotishError', code: 'CANCELLED' });
});
