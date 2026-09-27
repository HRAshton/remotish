import assert from 'node:assert/strict';
import test from 'node:test';
import { FileTimelineQueryService } from '../../packages/vscode-history/dist/timeline-query-service.js';

function token(cancelled = false) {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested() {
      return { dispose() {} };
    },
  };
}

function commit(revision, authoredAt) {
  return {
    revision,
    parents: [],
    message: revision,
    ...(authoredAt ? { authoredAt } : {}),
  };
}

test('file timeline: follows rename history and resumes from a cursor', async () => {
  const commits = [
    commit('C3', '2026-03-03T00:00:00Z'),
    commit('C2', '2026-03-02T00:00:00Z'),
    commit('C1', '2026-03-01T00:00:00Z'),
  ];
  const changes = new Map([
    ['C3', [{ type: 'renamed', path: 'new.txt', previousPath: 'old.txt' }]],
    ['C2', [{ type: 'modified', path: 'old.txt' }]],
    ['C1', [{ type: 'added', path: 'old.txt' }]],
  ]);
  const workspace = {
    baseRevision: 'C3',
    async getCommits(request) {
      assert.equal(request.revision, 'C3');
      assert.equal(request.limit, 25);
      return { commits };
    },
    async getCommitChanges(revision) {
      return changes.get(revision) ?? [];
    },
  };
  const service = new FileTimelineQueryService(workspace);

  const first = await service.load('new.txt', undefined, 1, undefined, token());
  assert.deepEqual(
    first.entries.map((entry) => [entry.commit.revision, entry.change.type]),
    [['C3', 'renamed']],
  );
  assert.ok(first.nextCursor);

  const second = await service.load('new.txt', first.nextCursor, 10, undefined, token());
  assert.deepEqual(
    second.entries.map((entry) => [entry.commit.revision, entry.change.type]),
    [
      ['C2', 'modified'],
      ['C1', 'added'],
    ],
  );
  assert.equal(second.nextCursor, undefined);
});

test('file timeline: filters invalid and older timestamps without stopping the walk', async () => {
  const workspace = {
    baseRevision: 'C3',
    async getCommits() {
      return {
        commits: [
          commit('C3', 'not-a-date'),
          commit('C2', '2026-02-01T00:00:00Z'),
          commit('C1', '2026-03-01T00:00:00Z'),
        ],
      };
    },
    async getCommitChanges(revision) {
      return [{ type: revision === 'C1' ? 'added' : 'modified', path: 'file.txt' }];
    },
  };
  const service = new FileTimelineQueryService(workspace);
  const minimum = Date.parse('2026-02-15T00:00:00Z');

  const page = await service.load('file.txt', undefined, 10, minimum, token());
  assert.deepEqual(
    page.entries.map((entry) => entry.commit.revision),
    ['C1'],
  );
});

test('file timeline: advances to the adapter next page when a cursor offset is exhausted', async () => {
  const calls = [];
  const workspace = {
    baseRevision: 'C2',
    async getCommits(request) {
      calls.push(request);
      if (request.cursor === 'next') {
        return { commits: [commit('C1', '2026-01-01T00:00:00Z')] };
      }
      return {
        commits: [commit('C2', '2026-01-02T00:00:00Z')],
        nextCursor: 'next',
      };
    },
    async getCommitChanges(revision) {
      return [{ type: revision === 'C1' ? 'added' : 'modified', path: 'file.txt' }];
    },
  };
  const service = new FileTimelineQueryService(workspace);
  const cursor = encodeURIComponent(
    JSON.stringify({ revision: 'C2', offset: 1, trackedPath: 'file.txt' }),
  );

  const page = await service.load('file.txt', cursor, 10, undefined, token());
  assert.deepEqual(
    page.entries.map((entry) => entry.commit.revision),
    ['C1'],
  );
  assert.equal(calls[0]?.cursor, undefined);
  assert.equal(calls[1]?.cursor, 'next');
});

test('file timeline: malformed or stale cursors restart from the pinned revision and requested path', async () => {
  const requests = [];
  const changesRequested = [];
  const workspace = {
    baseRevision: 'CURRENT',
    async getCommits(request) {
      requests.push(request);
      return { commits: [commit('CURRENT', '2026-01-01T00:00:00Z')] };
    },
    async getCommitChanges(revision) {
      changesRequested.push(revision);
      return [{ type: 'added', path: 'requested.txt' }];
    },
  };
  const service = new FileTimelineQueryService(workspace);

  const malformed = await service.load('requested.txt', '%', 5, undefined, token());
  assert.deepEqual(
    malformed.entries.map((entry) => entry.change.path),
    ['requested.txt'],
  );
  assert.equal(requests[0]?.revision, 'CURRENT');

  const stale = encodeURIComponent(
    JSON.stringify({ revision: 'OLD', offset: 0, trackedPath: 'wrong.txt' }),
  );
  const restarted = await service.load('requested.txt', stale, 5, undefined, token());
  assert.deepEqual(
    restarted.entries.map((entry) => entry.change.path),
    ['requested.txt'],
  );
  assert.deepEqual(changesRequested, ['CURRENT', 'CURRENT']);
});

test('file timeline: cancellation before the walk avoids remote calls', async () => {
  let calls = 0;
  const workspace = {
    baseRevision: 'C1',
    async getCommits() {
      calls += 1;
      return { commits: [] };
    },
    async getCommitChanges() {
      calls += 1;
      return [];
    },
  };
  const service = new FileTimelineQueryService(workspace);

  assert.deepEqual(await service.load('file.txt', undefined, 10, undefined, token(true)), {
    entries: [],
  });
  assert.equal(calls, 0);
});
