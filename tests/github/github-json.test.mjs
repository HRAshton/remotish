import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeBlob,
  decodeBranches,
  decodeCommitDetail,
  decodeCommitList,
  decodeGitCommit,
  decodeObjectSha,
  decodeRepository,
  decodeSha,
  decodeTree,
} from '../../adapters/github/dist/github-json.js';

function expectInvalid(action, message) {
  assert.throws(
    action,
    (error) => error?.code === 'UNKNOWN' && String(error.message).includes(message),
  );
}

test('github json: decodes optional repository, commit, and file metadata', () => {
  assert.deepEqual(
    decodeRepository({
      id: 1,
      node_id: 'R1',
      name: 'demo',
      full_name: 'acme/demo',
      description: null,
      default_branch: 'main',
    }),
    {
      id: 1,
      node_id: 'R1',
      name: 'demo',
      full_name: 'acme/demo',
      description: null,
      default_branch: 'main',
    },
  );

  assert.deepEqual(decodeBranches([{ name: 'main', commit: { sha: 'C1' } }]), [
    { name: 'main', commit: { sha: 'C1' } },
  ]);

  assert.deepEqual(
    decodeCommitList([
      {
        sha: 'C2',
        parents: [{ sha: 'C1' }],
        commit: { message: 'No author', author: null },
      },
      {
        sha: 'C1',
        parents: [],
        commit: { message: 'Partial author', author: { name: 'A' } },
      },
    ]),
    [
      {
        sha: 'C2',
        parents: [{ sha: 'C1' }],
        commit: { message: 'No author', author: null },
      },
      {
        sha: 'C1',
        parents: [],
        commit: { message: 'Partial author', author: { name: 'A' } },
      },
    ],
  );

  assert.deepEqual(
    decodeCommitDetail({
      sha: 'C3',
      parents: [{ sha: 'C2' }],
      commit: { message: 'Rename' },
      files: [
        { filename: 'new.txt', previous_filename: 'old.txt', status: 'renamed' },
        { filename: 'plain.txt', status: 'modified' },
      ],
    }),
    {
      sha: 'C3',
      parents: [{ sha: 'C2' }],
      commit: { message: 'Rename' },
      files: [
        { filename: 'new.txt', previous_filename: 'old.txt', status: 'renamed' },
        { filename: 'plain.txt', status: 'modified' },
      ],
    },
  );

  assert.deepEqual(
    decodeCommitDetail({
      sha: 'C4',
      parents: [],
      commit: { message: 'No files' },
    }),
    {
      sha: 'C4',
      parents: [],
      commit: { message: 'No files' },
    },
  );
});

test('github json: decodes git data objects and optional tree fields', () => {
  assert.deepEqual(
    decodeGitCommit({
      sha: 'C1',
      message: 'Initial',
      tree: { sha: 'T1' },
      parents: [],
    }),
    {
      sha: 'C1',
      message: 'Initial',
      tree: { sha: 'T1' },
      parents: [],
    },
  );

  assert.deepEqual(
    decodeTree({
      sha: 'T1',
      truncated: true,
      tree: [
        { path: 'file.txt', mode: '100644', type: 'blob', sha: 'B1', size: 4 },
        { path: 'dir', mode: '040000', type: 'tree', sha: 'T2' },
        { path: 'submodule', mode: '160000', type: 'commit', sha: 'C2' },
      ],
    }),
    {
      sha: 'T1',
      truncated: true,
      tree: [
        { path: 'file.txt', mode: '100644', type: 'blob', sha: 'B1', size: 4 },
        { path: 'dir', mode: '040000', type: 'tree', sha: 'T2' },
        { path: 'submodule', mode: '160000', type: 'commit', sha: 'C2' },
      ],
    },
  );

  assert.deepEqual(decodeBlob({ content: 'aGVsbG8=', encoding: 'base64' }), {
    content: 'aGVsbG8=',
    encoding: 'base64',
  });
  assert.deepEqual(decodeSha({ sha: 'B1' }), { sha: 'B1' });
  assert.deepEqual(decodeObjectSha({ object: { sha: 'C1' } }), { object: { sha: 'C1' } });
});

test('github json: rejects malformed optional and nested fields', () => {
  expectInvalid(() => decodeBranches({}), 'branches must be an array');
  expectInvalid(
    () =>
      decodeRepository({
        id: 1,
        node_id: 'R1',
        name: 'demo',
        full_name: 'acme/demo',
        description: 42,
        default_branch: 'main',
      }),
    'repository.description must be a string',
  );
  expectInvalid(
    () =>
      decodeCommitDetail({
        sha: 'C1',
        parents: [],
        commit: { message: 'x' },
        files: 'not-an-array',
      }),
    'commit.files must be an array',
  );
  expectInvalid(
    () =>
      decodeCommitDetail({
        sha: 'C1',
        parents: [],
        commit: { message: 'x' },
        files: [{ filename: 'new.txt', previous_filename: 7, status: 'renamed' }],
      }),
    'commit.files[0].previous_filename must be a string',
  );
  expectInvalid(
    () =>
      decodeTree({
        sha: 'T1',
        tree: [{ path: 'x', mode: '100644', type: 'other', sha: 'B1' }],
      }),
    'tree.tree[0].type must be blob, tree, or commit',
  );
  expectInvalid(
    () =>
      decodeTree({
        sha: 'T1',
        tree: [{ path: 'x', mode: '100644', type: 'blob', sha: 'B1', size: '4' }],
      }),
    'tree.tree[0].size must be a finite number',
  );
  expectInvalid(
    () => decodeTree({ sha: 'T1', truncated: 'yes', tree: [] }),
    'tree.truncated must be a boolean',
  );
  expectInvalid(
    () =>
      decodeTree({
        sha: 'T1',
        tree: [{ path: 'x'.repeat(8_193), mode: '100644', type: 'blob', sha: 'B1' }],
      }),
    'tree.tree[0].path exceeds the 8192-character limit',
  );
  expectInvalid(
    () => decodeBlob({ content: 1, encoding: 'base64' }),
    'blob.content must be a string',
  );
  expectInvalid(() => decodeSha(null), 'GitHub object must be an object');
  expectInvalid(() => decodeObjectSha({ object: null }), 'Git reference.object must be an object');
});
