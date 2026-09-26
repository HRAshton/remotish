import assert from 'node:assert/strict';
import test from 'node:test';
import { RemotishHistoryProvider } from '../../packages/vscode-history/dist/history-provider.js';

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('history provider reports detached remote-ref refresh failures', async (t) => {
  const listeners = new Set();
  const failure = new Error('listBranches failed');
  const reported = [];
  const workspace = {
    branch: 'main',
    baseRevision: 'C1',
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    async listBranches() {
      throw failure;
    },
  };

  const provider = new RemotishHistoryProvider('failing', workspace, (error) =>
    reported.push(error),
  );
  t.after(() => provider.dispose());

  await settle();
  assert.deepEqual(reported, [failure]);

  for (const listener of listeners) {
    listener({ branch: 'main', baseRevision: 'C1' });
  }
  await settle();
  assert.deepEqual(reported, [failure, failure]);
});
