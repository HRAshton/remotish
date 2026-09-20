import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ProviderRegistry } from '@remotish/vscode';

function provider(id, displayName = id) {
  return {
    apiVersion: 1,
    id,
    displayName,
    validateRepository(repository) {
      assert.equal(typeof repository, 'object');
    },
    createAdapter() {
      throw new Error('not used');
    },
  };
}

test('provider registry normalizes ids and disposes registrations', () => {
  const registry = new ProviderRegistry();
  const disposable = registry.register(
    provider('Bitbucket-Cloud', 'Bitbucket Cloud'),
    'example.bitbucket-cloud',
  );

  assert.equal(registry.require('bitbucket-cloud').id, 'bitbucket-cloud');
  assert.equal(registry.require('BITBUCKET-CLOUD').displayName, 'Bitbucket Cloud');
  assert.equal(registry.require('bitbucket-cloud').extensionId, 'example.bitbucket-cloud');
  assert.equal(registry.list().length, 1);

  disposable.dispose();
  assert.equal(registry.list().length, 0);
});

test('provider registry rejects duplicate and malformed registrations', () => {
  const registry = new ProviderRegistry();
  registry.register(provider('github'), 'example.github');

  assert.throws(() => registry.register(provider('GITHUB'), 'other.github'), {
    name: 'RemotishError',
    code: 'INVALID_REQUEST',
  });
  assert.throws(() => registry.register(provider('bad/provider'), 'example.bad'), {
    name: 'RemotishError',
    code: 'INVALID_REQUEST',
  });
  assert.throws(() => registry.register(provider('gitlab', '   '), 'example.gitlab'), {
    name: 'RemotishError',
    code: 'INVALID_REQUEST',
  });
  assert.throws(() => registry.register(provider('gitlab'), 'invalid'), {
    name: 'RemotishError',
    code: 'INVALID_REQUEST',
  });
  assert.throws(
    () => registry.register({ ...provider('gitlab'), apiVersion: 2 }, 'example.gitlab'),
    { name: 'RemotishError', code: 'UNSUPPORTED' },
  );
});
