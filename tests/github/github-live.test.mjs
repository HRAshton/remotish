import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubAdapter } from '@remotish/adapter-github';

const enabled = process.env.REMOTISH_LIVE_GITHUB === '1';

test('github live: reads a public repository without a token', { skip: !enabled }, async () => {
  const adapter = new GitHubAdapter({ owner: 'octocat', repository: 'Hello-World' });
  const repository = await adapter.getRepository();
  const branches = await adapter.getBranches();
  const branch = branches.find((candidate) => candidate.name === repository.defaultBranch);

  assert.ok(branch, 'default branch should exist');
  const root = await adapter.readDirectory(branch.revision, '');
  assert.ok(root.some((entry) => entry.name === 'README'));
  assert.match(
    new TextDecoder().decode(await adapter.readFile(branch.revision, 'README')),
    /Hello World!/,
  );
});
