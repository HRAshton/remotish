import assert from 'node:assert/strict';
import test from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import { RemotishWorkspace } from '@remotish/core';
import { HistoryQueryService } from '@remotish/vscode-history/queries';

const token = {
  isCancellationRequested: false,
  onCancellationRequested() {
    return { dispose() {} };
  },
};

test('history queries: multiple refs preserve divergent remote history', async () => {
  const workspace = await RemotishWorkspace.open(new FixtureAdapter());
  const queries = new HistoryQueryService(workspace);
  const commits = await queries.loadRefCommits(
    ['workspace:main', 'branch:feature/test'],
    20,
    token,
  );
  assert.deepEqual(
    new Set(commits.map((commit) => commit.revision)),
    new Set(['C1', 'C2', 'C3', 'F1', 'F2']),
  );
});

test('history queries: common ancestor resolves across branch refs', async () => {
  const workspace = await RemotishWorkspace.open(new FixtureAdapter());
  const queries = new HistoryQueryService(workspace);
  assert.equal(
    await queries.resolveCommonAncestor(['workspace:main', 'branch:feature/test'], token),
    'C2',
  );
});

test('history queries: workspace ref stays pinned when remote branch moves', async () => {
  const adapter = new FixtureAdapter();
  const workspace = await RemotishWorkspace.open(adapter);
  const queries = new HistoryQueryService(workspace);
  adapter.moveBranchHead('main', 'C2');

  const pinned = await queries.loadRefCommits(['workspace:main'], 1, token);
  const remote = await queries.loadRefCommits(['branch:main'], 1, token);
  assert.equal(pinned[0]?.revision, 'C3');
  assert.equal(remote[0]?.revision, 'C2');
});
