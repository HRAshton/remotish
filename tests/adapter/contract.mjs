import assert from 'node:assert/strict';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function runRemotishAdapterContractTests(test, createAdapter) {
  test('adapter: repository and immutable reads', async () => {
    const adapter = createAdapter();
    const repository = await adapter.getRepository();
    assert.equal(repository.defaultBranch, 'main');

    const branches = await adapter.getBranches();
    const main = branches.find((branch) => branch.name === repository.defaultBranch);
    assert.ok(main);

    const root = await adapter.readDirectory(main.revision, '');
    assert.ok(root.some((entry) => entry.path === 'README.md'));
    assert.match(decoder.decode(await adapter.readFile(main.revision, 'README.md')), /Fixture/);

    const binary = await adapter.readFile(main.revision, 'assets/sample.bin');
    assert.deepEqual([...binary], [0, 1, 2, 127, 128, 255]);
  });

  test('adapter: history and changed files', async () => {
    const adapter = createAdapter();
    const page = await adapter.getCommits({ branch: 'main', limit: 2 });
    assert.equal(page.commits.length, 2);
    assert.equal(page.commits[0].revision, 'C3');
    assert.ok(page.nextCursor);

    const next = await adapter.getCommits({ branch: 'main', limit: 2, cursor: page.nextCursor });
    assert.equal(next.commits[0].revision, 'C1');

    const changes = await adapter.getCommitChanges('C3');
    assert.ok(changes.some((change) => change.type === 'modified' && change.path === 'README.md'));
    assert.ok(changes.some((change) => change.type === 'added' && change.path === 'src/util.ts'));
  });

  test('adapter: normal commit publishes and stale normal commit rejects', async () => {
    const adapter = createAdapter();
    const result = await adapter.commit({
      type: 'commit',
      branch: 'main',
      baseRevision: 'C3',
      message: 'Update README',
      changes: [{ type: 'modify', path: 'README.md', content: encoder.encode('updated\n') }],
      push: { mode: 'normal' },
    });
    assert.equal(result.status, 'success');
    if (result.status !== 'success') {
      return;
    }
    assert.equal(adapter.getBranchHead('main'), result.revision);
    assert.equal(decoder.decode(await adapter.readFile(result.revision, 'README.md')), 'updated\n');

    const stale = await adapter.commit({
      type: 'commit',
      branch: 'main',
      baseRevision: 'C3',
      message: 'Stale update',
      changes: [{ type: 'modify', path: 'README.md', content: encoder.encode('stale\n') }],
      push: { mode: 'normal' },
    });
    assert.deepEqual(stale, {
      status: 'rejected',
      reason: 'REMOTE_CHANGED',
      remoteRevision: result.revision,
      message: `Remote branch now points to ${result.revision}.`,
    });
  });

  test('adapter: force-with-lease can replace a moved branch but still protects the lease', async () => {
    const adapter = createAdapter();
    adapter.moveBranchHead('main', 'F2');

    const pushed = await adapter.commit({
      type: 'commit',
      branch: 'main',
      baseRevision: 'C3',
      message: 'Force from workspace base',
      changes: [{ type: 'modify', path: 'README.md', content: encoder.encode('forced\n') }],
      push: { mode: 'force-with-lease', expectedRevision: 'F2' },
    });
    assert.equal(pushed.status, 'success');
    if (pushed.status !== 'success') {
      return;
    }
    assert.deepEqual(pushed.commit.parents, ['C3']);

    adapter.moveBranchHead('main', 'F2');
    const rejected = await adapter.commit({
      type: 'commit',
      branch: 'main',
      baseRevision: 'C3',
      message: 'Bad lease',
      changes: [{ type: 'modify', path: 'README.md', content: encoder.encode('nope\n') }],
      push: { mode: 'force-with-lease', expectedRevision: pushed.revision },
    });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.reason, 'REMOTE_CHANGED');
    assert.equal(rejected.remoteRevision, 'F2');
  });

  test('adapter: amend rewrites the base commit and requires a matching lease', async () => {
    const adapter = createAdapter();
    const amended = await adapter.commit({
      type: 'amend',
      branch: 'main',
      baseRevision: 'C3',
      message: 'Amended C3',
      changes: [{ type: 'modify', path: 'README.md', content: encoder.encode('amended\n') }],
      push: { mode: 'force-with-lease', expectedRevision: 'C3' },
    });
    assert.equal(amended.status, 'success');
    if (amended.status !== 'success') {
      return;
    }
    assert.deepEqual(amended.commit.parents, ['C2']);
    assert.equal(adapter.getBranchHead('main'), amended.revision);

    const adapter2 = createAdapter();
    adapter2.moveBranchHead('main', 'F2');
    const rejected = await adapter2.commit({
      type: 'amend',
      branch: 'main',
      baseRevision: 'C3',
      message: 'Amended C3',
      changes: [{ type: 'modify', path: 'README.md', content: encoder.encode('amended\n') }],
      push: { mode: 'force-with-lease', expectedRevision: 'C3' },
    });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.remoteRevision, 'F2');
  });

  test('adapter: branch management is remote and revision-bound', async () => {
    const adapter = createAdapter();
    const created = await adapter.createBranch('feature/new', 'C2');
    assert.deepEqual(created, { name: 'feature/new', revision: 'C2' });
    assert.ok((await adapter.getBranches()).some((branch) => branch.name === 'feature/new'));
    await adapter.deleteBranch('feature/new');
    assert.ok(!(await adapter.getBranches()).some((branch) => branch.name === 'feature/new'));
  });
}
