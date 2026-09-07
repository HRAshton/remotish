import assert from 'node:assert/strict';
import test from 'node:test';
import { RemotishError } from '@remotish/adapter-sdk';
import * as vscode from 'vscode';
import { runCommand } from '../../packages/vscode/dist/commands/run-command.js';

test('command boundary keeps cancellation silent', async () => {
  vscode.__test.reset();
  const logger = testLogger();
  await runCommand(logger, async () => {
    throw new RemotishError('CANCELLED', 'Operation cancelled.');
  });
  assert.deepEqual(vscode.__test.errorMessages, []);
});

test('command boundary preserves validation detail and classifies remote failures', async () => {
  vscode.__test.reset();
  const logger = testLogger();
  await runCommand(logger, async () => {
    throw new RemotishError('INVALID_REQUEST', 'Commit message is required.');
  });
  await runCommand(logger, async () => {
    throw new RemotishError('RATE_LIMITED', 'Try again later.');
  });

  assert.deepEqual(vscode.__test.errorMessages, [
    'Commit message is required.',
    'Remote service rate limit reached: Try again later.',
  ]);
});

test('command boundary logs unexpected failures through the supplied logger', async () => {
  vscode.__test.reset();
  const entries = [];
  const logger = testLogger(entries);
  const failure = new Error('transport exploded');

  await runCommand(logger, async () => {
    throw failure;
  });

  assert.deepEqual(vscode.__test.errorMessages, ['Remotish operation failed: transport exploded']);
  assert.deepEqual(entries, [{ message: 'Unexpected Remotish command failure.', error: failure }]);
});

function testLogger(entries = []) {
  return {
    error(message, error) {
      entries.push({ message, error });
    },
  };
}
