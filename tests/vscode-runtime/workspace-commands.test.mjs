import assert from 'node:assert/strict';
import test from 'node:test';
import * as vscode from 'vscode';
import { registerRefreshCommand } from '../../packages/vscode/dist/commands/refresh-command.js';
import { resolveWorkspaceId } from '../../packages/vscode/dist/commands/workspace-argument.js';

function makeRegistration(id, name = id, branch = 'main') {
  return {
    id,
    workspace: {
      branch,
      repositoryInfo: { name },
    },
  };
}

function makeRegistry(registrations) {
  return {
    list() {
      return registrations;
    },
    require(id) {
      const registration = registrations.find((candidate) => candidate.id === id);
      if (!registration) {
        throw new Error(`Unknown workspace: ${id}`);
      }
      return registration;
    },
  };
}

test('workspace argument: explicit, empty, single, selected, and cancelled resolution', async () => {
  vscode.__test.reset();

  const explicitRegistry = {
    require(value) {
      assert.equal(value, 'alias');
      return { id: 'canonical' };
    },
    list() {
      throw new Error('list should not be used for an explicit id');
    },
  };
  assert.equal(await resolveWorkspaceId(explicitRegistry, 'alias'), 'canonical');

  await assert.rejects(
    resolveWorkspaceId(makeRegistry([])),
    (error) => error?.code === 'INVALID_REQUEST' && /No Remotish workspace/u.test(error.message),
  );

  const one = makeRegistration('one', 'One');
  assert.equal(await resolveWorkspaceId(makeRegistry([one])), 'one');

  const first = makeRegistration('first', 'First', 'main');
  const second = makeRegistration('second', 'Second', 'feature/test');
  vscode.__test.quickPickResponses.push(1);
  assert.equal(await resolveWorkspaceId(makeRegistry([first, second])), 'second');

  await assert.rejects(
    resolveWorkspaceId(makeRegistry([first, second])),
    (error) => error?.code === 'CANCELLED' && /selection cancelled/u.test(error.message),
  );
});

test('refresh command: reports updated, pinned, and unchanged remote-head states', async (t) => {
  vscode.__test.reset();
  const results = [
    { status: 'updated', remoteRevision: 'C2' },
    { status: 'pinned', remoteRevision: 'C3', baseRevision: 'C1' },
    { status: 'unchanged', remoteRevision: 'C3' },
  ];
  const registration = makeRegistration('workspace', 'Demo');
  registration.workspace.refreshRemoteHead = async () => results.shift();
  const registry = makeRegistry([registration]);
  const logged = [];
  const disposable = registerRefreshCommand(registry, {
    error(message, error) {
      logged.push({ message, error });
    },
  });
  t.after(() => disposable.dispose());

  await vscode.commands.executeCommand('remotish.refresh', 'workspace');
  await vscode.commands.executeCommand('remotish.refresh', 'workspace');
  await vscode.commands.executeCommand('remotish.refresh', 'workspace');

  assert.deepEqual(vscode.__test.infoMessages, ['Updated to remote revision C2.']);
  assert.deepEqual(vscode.__test.warningMessages, [
    'Remote branch is now C3; working changes remain pinned to C1.',
  ]);
  assert.deepEqual(vscode.__test.errorMessages, []);
  assert.deepEqual(logged, []);
});

test('refresh command: command-palette cancellation remains silent', async (t) => {
  vscode.__test.reset();
  const registry = makeRegistry([
    makeRegistration('first', 'First'),
    makeRegistration('second', 'Second'),
  ]);
  const disposable = registerRefreshCommand(registry, {
    error() {
      throw new Error('cancellation should not be logged');
    },
  });
  t.after(() => disposable.dispose());

  await vscode.commands.executeCommand('remotish.refresh');
  assert.deepEqual(vscode.__test.errorMessages, []);
  assert.deepEqual(vscode.__test.infoMessages, []);
  assert.deepEqual(vscode.__test.warningMessages, []);
});
