import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createStableWorkspaceId } from '@remotish/vscode';

test('stable workspace ids are provider/repository based and branch independent', async () => {
  const first = await createStableWorkspaceId('Bitbucket-Cloud', 'repo-123');
  const again = await createStableWorkspaceId('bitbucket-cloud', 'repo-123');
  const otherRepository = await createStableWorkspaceId('bitbucket-cloud', 'repo-456');
  const otherProvider = await createStableWorkspaceId('github', 'repo-123');

  assert.equal(first, again);
  assert.match(first, /^bitbucket-cloud-[a-f0-9]{32}$/u);
  assert.notEqual(first, otherRepository);
  assert.notEqual(first, otherProvider);
});

test('stable workspace ids reject empty repository identity', async () => {
  await assert.rejects(() => createStableWorkspaceId('github', '   '), {
    name: 'RemotishError',
    code: 'INVALID_REQUEST',
  });
});
