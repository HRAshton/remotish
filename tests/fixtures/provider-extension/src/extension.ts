import { FixtureAdapter } from '@remotish/adapter-fixture';
import {
  REMOTISH_ADAPTER_PROVIDER_API_VERSION,
  type RemotishAdapterProviderV1,
} from '@remotish/adapter-sdk';

export async function activate(): Promise<RemotishAdapterProviderV1> {
  return {
    apiVersion: REMOTISH_ADAPTER_PROVIDER_API_VERSION,
    id: 'fixture-provider',
    displayName: 'Fixture Provider',
    validateRepository(repository) {
      const keys = Object.keys(repository).sort();
      if (
        keys.length !== 1 ||
        keys[0] !== 'repository' ||
        repository.repository !== 'demo'
      ) {
        throw new Error('Fixture provider expects repository=demo only.');
      }
    },
    createAdapter() {
      return new FixtureAdapter();
    },
  };
}
