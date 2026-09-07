import assert from 'node:assert/strict';
import test from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import { RemotishWorkspace } from '@remotish/core';
import { MementoWorkspaceStorage } from '@remotish/vscode/model';

function memento() {
  const values = new Map();
  return {
    get(key, defaultValue) {
      return values.has(key) ? values.get(key) : defaultValue;
    },
    async update(key, value) {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    },
  };
}

test('vscode persistence: Memento storage restores selected branch and independent binary-safe overlays', async () => {
  const adapter = new FixtureAdapter();
  const storage = new MementoWorkspaceStorage(memento(), 'round-trip');
  const first = await RemotishWorkspace.open(adapter, storage);

  await first.writeFile('README.md', new TextEncoder().encode('# Main edit\n'), {
    create: false,
    overwrite: true,
  });
  await first.switchBranch('feature/test');
  await first.writeFile('src/feature.ts', new Uint8Array([0, 255, 7]), {
    create: false,
    overwrite: true,
  });

  const restored = await RemotishWorkspace.open(adapter, storage);
  assert.equal(restored.branch, 'feature/test');
  assert.deepEqual(await restored.readFile('src/feature.ts'), new Uint8Array([0, 255, 7]));
  await restored.switchBranch('main');
  assert.equal(new TextDecoder().decode(await restored.readFile('README.md')), '# Main edit\n');
});

test('vscode persistence: Memento rejects present but malformed state', async () => {
  const state = memento();
  const storage = new MementoWorkspaceStorage(state, 'invalid');
  await state.update('remotish.workspace.invalid.fixture-demo', false);

  await assert.rejects(
    storage.load('fixture-demo'),
    /Invalid persisted Remotish workspace.*workspace snapshot must be an object/u,
  );
});

test('vscode persistence: Memento preserves prototype-named Git branches', async () => {
  for (const branch of ['__proto__', 'constructor', 'toString']) {
    const adapter = new FixtureAdapter();
    await adapter.createBranch(branch, 'C3');
    const storage = new MementoWorkspaceStorage(memento(), `prototype-${branch}`);
    const first = await RemotishWorkspace.open(adapter, storage);

    await first.switchBranch(branch);
    await first.writeFile('README.md', new TextEncoder().encode(`# ${branch}\n`), {
      create: false,
      overwrite: true,
    });

    const restored = await RemotishWorkspace.open(adapter, storage);
    assert.equal(restored.branch, branch);
    assert.equal(new TextDecoder().decode(await restored.readFile('README.md')), `# ${branch}\n`);
  }
});
