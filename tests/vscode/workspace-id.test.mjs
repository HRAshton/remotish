import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createStableWorkspaceId, verifyStableWorkspaceId } from '@remotish/vscode';

test('stable workspace id v1 has a fixed persisted compatibility vector', async () => {
  assert.equal(
    await createStableWorkspaceId('Bitbucket-Cloud', 'repo-123'),
    'bitbucket-cloud-c65918b04e8dee7a234ca0c329176dcb',
  );
});

test('stable workspace ids are provider/repository based and branch independent', async () => {
  const first = await createStableWorkspaceId('Bitbucket-Cloud', 'repo-123');
  const again = await createStableWorkspaceId('bitbucket-cloud', 'repo-123');
  const otherRepository = await createStableWorkspaceId('bitbucket-cloud', 'repo-456');
  const otherProvider = await createStableWorkspaceId('github', 'repo-123');

  assert.equal(first, again);
  assert.notEqual(first, otherRepository);
  assert.notEqual(first, otherProvider);
});

test('restoration rejects a descriptor that resolves to a different repository identity', async () => {
  await assert.rejects(
    () =>
      verifyStableWorkspaceId(
        'bitbucket-cloud',
        'repo-456',
        'bitbucket-cloud-c65918b04e8dee7a234ca0c329176dcb',
      ),
    { name: 'RemotishError', code: 'INVALID_REQUEST' },
  );
});
