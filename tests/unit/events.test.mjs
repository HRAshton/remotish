import assert from 'node:assert/strict';
import test from 'node:test';
import { EventSource } from '@remotish/core';

test('events: listener failures do not fail the emitting operation or block later listeners', () => {
  const failures = [];
  const received = [];
  const events = new EventSource((error) => failures.push(error));
  const expected = new Error('listener failed');

  events.on(() => {
    throw expected;
  });
  const subscription = events.on((value) => received.push(value));

  assert.doesNotThrow(() => events.emit('first'));
  assert.deepEqual(received, ['first']);
  assert.deepEqual(failures, [expected]);

  subscription.dispose();
  events.emit('second');
  assert.deepEqual(received, ['first']);
  assert.deepEqual(failures, [expected, expected]);
});
