const assert = require('node:assert/strict');
const test = require('node:test');
const fc = require('fast-check');

const PROPERTY_PARAMETERS = { numRuns: 500, seed: 0x5eedc0de };
const textUnit = fc
  .integer({ min: 1, max: 126 })
  .map((value) => String.fromCharCode(value));
const text = fc.string({ unit: textUnit, minLength: 1, maxLength: 32 });
const branchName = fc.oneof(fc.constant('__proto__'), fc.constant('constructor'), text);
const overlay = fc.record(
  {
    files: fc.array(fc.tuple(text, fc.uint8Array({ maxLength: 128 })), { maxLength: 4 }),
    directories: fc.array(text, { maxLength: 4 }),
    deletedPaths: fc.array(text, { maxLength: 4 }),
    renames: fc.array(fc.tuple(text, text), { maxLength: 4 }),
  },
  { noNullPrototype: true },
);
const publication = fc.option(
  fc.oneof(
    text.map((expectedRemoteRevision) => ({ phase: 'prepared', expectedRemoteRevision })),
    fc.tuple(text, text).map(([expectedRemoteRevision, publishedRevision]) => ({
      phase: 'published',
      expectedRemoteRevision,
      publishedRevision,
    })),
  ),
  { nil: undefined },
);

const snapshot = fc
  .tuple(branchName, text, overlay, publication)
  .map(([selectedBranch, baseRevision, generatedOverlay, pending]) => {
    const branches = Object.create(null);
    branches[selectedBranch] = {
      baseRevision,
      overlay: {
        files: generatedOverlay.files.map(([path, content]) => ({ path, content })),
        directories: generatedOverlay.directories,
        deletedPaths: generatedOverlay.deletedPaths,
        renames: generatedOverlay.renames.map(([from, to]) => ({ from, to })),
      },
    };
    return {
      version: 1,
      selectedBranch,
      branches,
      ...(pending
        ? { pendingCommitPublication: { ...pending, branch: selectedBranch } }
        : {}),
    };
  });

test('workspace persistence codec round-trips generated valid snapshots through JSON', async () => {
  const { decodeWorkspaceSnapshot, encodeWorkspaceSnapshot } = await import(
    '@remotish/vscode/model'
  );

  fc.assert(
    fc.property(snapshot, (value) => {
      const persisted = JSON.parse(JSON.stringify(encodeWorkspaceSnapshot(value)));
      assert.deepEqual(decodeWorkspaceSnapshot(persisted), value);
    }),
    PROPERTY_PARAMETERS,
  );
});
