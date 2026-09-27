import assert from 'node:assert/strict';
import test from 'node:test';
import {
  requireBranch,
  requireNotAborted,
  requireRepoPath,
  requireRevision,
  toCommitInfo,
} from '../../adapters/git-http/dist/git-validation.js';

function expectInvalid(action) {
  assert.throws(action, (error) => error?.code === 'INVALID_REQUEST');
}

test('git validation: accepts full revisions and rejects malformed revisions', () => {
  const revision = 'a'.repeat(40);
  assert.equal(requireRevision(revision), revision);
  for (const candidate of ['', 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), 'A'.repeat(40)]) {
    expectInvalid(() => requireRevision(candidate));
  }
});

test('git validation: enforces Git branch-name safety rules', () => {
  for (const candidate of ['main', 'feature/test-1', 'release/v1.0.0']) {
    assert.equal(requireBranch(candidate), candidate);
  }

  for (const candidate of [
    '',
    '@',
    '/main',
    'main/',
    '.hidden',
    'main.',
    'feature..test',
    'feature//test',
    'feature@{test',
    'feature/.hidden',
    'feature/test.lock',
    'feature test',
    'feature\u007ftest',
    'feature~test',
    'feature^test',
    'feature:test',
    'feature?test',
    'feature*test',
    'feature[test',
    'feature\\test',
  ]) {
    expectInvalid(() => requireBranch(candidate));
  }
});

test('git validation: accepts normalized repository paths and rejects aliases or .git access', () => {
  assert.equal(requireRepoPath('src/file.ts'), 'src/file.ts');
  assert.equal(requireRepoPath('README.md'), 'README.md');

  for (const candidate of [
    '/src/file.ts',
    'src/file.ts/',
    'src\\file.ts',
    'src//file.ts',
    'src/./file.ts',
    'src/../file.ts',
    '.git',
    '.git/config',
  ]) {
    expectInvalid(() => requireRepoPath(candidate));
  }
});

test('git validation: cancellation and commit metadata mapping are stable', () => {
  assert.doesNotThrow(() => requireNotAborted());
  assert.doesNotThrow(() => requireNotAborted(new AbortController().signal));

  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => requireNotAborted(controller.signal),
    (error) => error?.code === 'CANCELLED',
  );

  assert.deepEqual(
    toCommitInfo('b'.repeat(40), {
      tree: 't'.repeat(40),
      parent: ['a'.repeat(40)],
      message: 'Message',
      author: {
        name: 'Author',
        email: 'author@example.test',
        timestamp: 1_700_000_000,
        timezoneOffset: 0,
      },
      committer: {
        name: 'Committer',
        email: 'committer@example.test',
        timestamp: 1_700_000_001,
        timezoneOffset: 0,
      },
    }),
    {
      revision: 'b'.repeat(40),
      parents: ['a'.repeat(40)],
      message: 'Message',
      author: { name: 'Author', email: 'author@example.test' },
      authoredAt: new Date(1_700_000_000 * 1000).toISOString(),
    },
  );
});
