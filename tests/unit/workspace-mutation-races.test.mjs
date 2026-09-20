import assert from 'node:assert/strict';
import test from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import { RemotishError } from '@remotish/adapter-sdk';
import { RemotishWorkspace } from '@remotish/core';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test('workspace commit: queued branch switch cannot redirect a guarded normal commit', async () => {
  const adapter = new FixtureAdapter();
  const workspace = await RemotishWorkspace.open(adapter);

  await workspace.writeFile('README.md', encoder.encode('main local\n'), {
    create: false,
    overwrite: true,
  });
  await workspace.switchBranch('feature/test');
  await workspace.writeFile('README.md', encoder.encode('feature local\n'), {
    create: false,
    overwrite: true,
  });
  await workspace.switchBranch('main');

  const expectedState = { branch: workspace.branch, baseRevision: workspace.baseRevision };
  const switchBranch = workspace.switchBranch('feature/test');
  const commit = workspace.commitAndPush('Do not publish feature', ['README.md'], expectedState);

  await switchBranch;
  await assert.rejects(
    commit,
    (error) => error instanceof RemotishError && error.code === 'INVALID_REQUEST',
  );

  assert.equal(adapter.getBranchHead('feature/test'), 'F2');
  assert.equal(decoder.decode(await workspace.readFile('README.md')), 'feature local\n');
});
