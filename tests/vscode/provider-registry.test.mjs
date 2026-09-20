import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ProviderRegistry } from '@remotish/vscode';

function provider(id, displayName = id) {
  return {
    id,
    displayName,
    createAdapter() {
      throw new Error('not used');
    },
  };
}

test('provider registry normalizes ids and disposes registrations', () => {
  const registry = new ProviderRegistry();
  const disposable = registry.register(provider('Bitbucket-Cloud', 'Bitbucket Cloud'));

  assert.equal(registry.require('bitbucket-cloud').id, 'bitbucket-cloud');
  assert.equal(registry.require('BITBUCKET-CLOUD').displayName, 'Bitbucket Cloud');
  assert.equal(registry.list().length, 1);

  disposable.dispose();
  assert.equal(registry.list().length, 0);
});

test('provider registry rejects duplicate and malformed registrations', () => {
  const registry = new ProviderRegistry();
  registry.register(provider('github'));

  assert.throws(() => registry.register(provider('GITHUB')), {
    name: 'RemotishError',
    code: 'INVALID_REQUEST',
  });
  assert.throws(() => registry.register(provider('bad/provider')), {
    name: 'RemotishError',
    code: 'INVALID_REQUEST',
  });
  assert.throws(() => registry.register(provider('gitlab', '   ')), {
    name: 'RemotishError',
    code: 'INVALID_REQUEST',
  });
});

test('provider registry reports an unregistered provider distinctly', () => {
  const registry = new ProviderRegistry();

  assert.throws(() => registry.require('bitbucket-cloud'), {
    name: 'RemotishError',
    code: 'NOT_FOUND',
  });
});
