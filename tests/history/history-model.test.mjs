import assert from 'node:assert/strict';
import test from 'node:test';
import {
  branchNameFromRef,
  branchRef,
  toHistoryChange,
  toHistoryItem,
  workspaceRef,
} from '@remotish/vscode-history/model';

test('history model: refs keep workspace and remote branch concepts separate', () => {
  assert.deepEqual(workspaceRef('main', 'C3'), {
    id: 'workspace:main',
    name: 'main',
    revision: 'C3',
    category: 'Workspace',
  });
  assert.deepEqual(branchRef({ name: 'main', revision: 'C4' }), {
    id: 'branch:main',
    name: 'main',
    revision: 'C4',
    category: 'Remote Branches',
  });
  assert.equal(branchNameFromRef('branch:feature/test'), 'feature/test');
});

test('history model: commits and changed-file URIs are revision pinned', () => {
  assert.deepEqual(
    toHistoryItem({
      revision: 'abcdef1234567890',
      parents: ['parent'],
      message: 'Subject\n\nBody',
      author: { name: 'A', email: 'a@example.invalid' },
      authoredAt: '2026-09-18T00:00:00.000Z',
    }),
    {
      id: 'abcdef1234567890',
      parentIds: ['parent'],
      subject: 'Subject',
      message: 'Subject\n\nBody',
      displayId: 'abcdef123456',
      author: 'A',
      authorEmail: 'a@example.invalid',
      timestamp: Date.parse('2026-09-18T00:00:00.000Z'),
    },
  );

  const changed = toHistoryChange('fixture-demo', 'C3', 'C2', {
    type: 'modified',
    path: 'README.md',
  });
  assert.equal(changed.originalUri.query, 'revision=C2');
  assert.equal(changed.modifiedUri.query, 'revision=C3');

  const renamed = toHistoryChange('fixture-demo', 'C3', 'C2', {
    type: 'renamed',
    path: 'new.ts',
    previousPath: 'old.ts',
  });
  assert.equal(renamed.originalUri.path, '/old.ts');
  assert.equal(renamed.modifiedUri.path, '/new.ts');
});
