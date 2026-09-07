import assert from 'node:assert/strict';
import test from 'node:test';
import * as vscode from 'vscode';
import { RemotishSourceControl } from '../../packages/vscode/dist/scm/source-control.js';

function controlledWorkspace() {
  const listeners = new Set();
  const pending = [];
  let active = 0;
  let maxActive = 0;
  let calls = 0;

  const workspace = {
    branch: 'main',
    baseRevision: 'C1',
    capabilities: { commits: true, forceWithLease: false, amend: false },
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    getChanges() {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      let resolve;
      const promise = new Promise((done) => {
        resolve = done;
      }).finally(() => {
        active -= 1;
      });
      pending.push({ resolve, promise });
      return promise;
    },
  };

  return {
    workspace,
    get calls() {
      return calls;
    },
    get maxActive() {
      return maxActive;
    },
    pending,
    change() {
      for (const listener of [...listeners]) {
        listener({ branch: workspace.branch, baseRevision: workspace.baseRevision });
      }
    },
  };
}

function group(sourceControl, id) {
  const result = sourceControl.__groups.find((candidate) => candidate.id === id);
  assert.ok(result);
  return result;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('source control coalesces refresh bursts and never overlaps getChanges calls', async (t) => {
  vscode.__test.reset();
  const controlled = controlledWorkspace();
  const scm = new RemotishSourceControl('controlled', controlled.workspace);
  t.after(() => {
    scm.dispose();
    vscode.__test.reset();
  });

  assert.equal(controlled.calls, 1);
  controlled.change();
  controlled.change();
  controlled.change();
  assert.equal(controlled.calls, 1);
  assert.equal(controlled.maxActive, 1);

  controlled.pending[0].resolve([{ type: 'modified', path: 'old.ts' }]);
  await settle();
  assert.equal(controlled.calls, 2);
  assert.equal(controlled.maxActive, 1);

  controlled.pending[1].resolve([{ type: 'modified', path: 'new.ts' }]);
  await settle();

  assert.equal(controlled.calls, 2);
  assert.deepEqual(
    group(scm.sourceControl, 'changes').resourceStates.map((state) => state.resourceUri.path),
    ['/new.ts'],
  );
});

test('source control discards a refresh captured from a branch that changed in flight', async (t) => {
  vscode.__test.reset();
  const controlled = controlledWorkspace();
  const scm = new RemotishSourceControl('controlled', controlled.workspace);
  t.after(() => {
    scm.dispose();
    vscode.__test.reset();
  });

  controlled.workspace.branch = 'feature';
  controlled.change();
  controlled.pending[0].resolve([{ type: 'modified', path: 'main-only.ts' }]);
  await settle();

  assert.equal(controlled.calls, 2);
  assert.deepEqual(group(scm.sourceControl, 'changes').resourceStates, []);

  controlled.pending[1].resolve([{ type: 'modified', path: 'feature.ts' }]);
  await settle();
  assert.deepEqual(
    group(scm.sourceControl, 'changes').resourceStates.map((state) => state.resourceUri.path),
    ['/feature.ts'],
  );
});

test('disposing source control prevents an in-flight refresh from mutating UI state', async () => {
  vscode.__test.reset();
  const controlled = controlledWorkspace();
  const scm = new RemotishSourceControl('controlled', controlled.workspace);
  const changes = group(scm.sourceControl, 'changes');

  scm.dispose();
  controlled.pending[0].resolve([{ type: 'modified', path: 'too-late.ts' }]);
  await settle();

  assert.deepEqual(changes.resourceStates, []);
  assert.equal(vscode.__test.sourceControls.length, 0);
  vscode.__test.reset();
});
