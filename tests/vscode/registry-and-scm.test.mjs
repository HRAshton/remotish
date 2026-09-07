import assert from 'node:assert/strict';
import test from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import { RemotishWorkspace } from '@remotish/core';
import {
  parseScmResourceArgument,
  toScmChangeResource,
  WorkspaceRegistry,
  workingUriParts,
} from '@remotish/vscode/model';

const encoder = new TextEncoder();

test('workspace registry: validates ids and forwards workspace changes', async () => {
  const workspace = await RemotishWorkspace.open(new FixtureAdapter());
  const registry = new WorkspaceRegistry();
  const changed = [];
  registry.onDidWorkspaceChange((event) => changed.push(event.registration.id));
  const dispose = registry.register('Fixture-Demo', workspace);

  assert.equal(registry.require('fixture-demo').workspace, workspace);
  await workspace.writeFile('README.md', encoder.encode('changed\n'), {
    create: false,
    overwrite: true,
  });
  assert.deepEqual(changed, ['fixture-demo']);

  dispose.dispose();
  assert.equal(registry.get('fixture-demo'), undefined);
  assert.throws(() => registry.register('bad/id', workspace));
});

test('scm change mapping is deterministic and UI-neutral', () => {
  assert.deepEqual(toScmChangeResource({ type: 'deleted', path: 'old.ts' }), {
    path: 'old.ts',
    type: 'deleted',
    icon: 'diff-removed',
    tooltip: 'Deleted',
    strikeThrough: true,
  });
  assert.deepEqual(
    toScmChangeResource({ type: 'renamed', path: 'new.ts', originalPath: 'old.ts' }),
    {
      path: 'new.ts',
      type: 'renamed',
      originalPath: 'old.ts',
      icon: 'diff-renamed',
      tooltip: 'Renamed from old.ts',
      strikeThrough: false,
    },
  );
});

test('scm resource arguments accept VS Code resource-state and group shapes', () => {
  const resourceUri = { query: '', ...workingUriParts('fixture-demo', 'src/index.ts') };
  assert.deepEqual(parseScmResourceArgument({ resourceUri }), {
    workspaceId: 'fixture-demo',
    path: 'src/index.ts',
  });
  assert.deepEqual(parseScmResourceArgument({ resourceStates: [{ resourceUri }] }), {
    workspaceId: 'fixture-demo',
    path: 'src/index.ts',
  });
});
