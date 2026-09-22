import { FixtureAdapter } from '@remotish/adapter-fixture';
import {
  REMOTISH_ADAPTER_PROVIDER_API_VERSION,
  REMOTISH_OPEN_REPOSITORY_COMMAND,
  REMOTISH_REPOSITORY_COMMAND_VERSION,
  type RemotishAdapterProviderV1,
  type RemotishRepositoryCommandV1,
  type RemotishRepositoryRequest,
} from '@remotish/adapter-sdk';
import * as vscode from 'vscode';

const PROVIDER_ID = 'fixture-provider';
const REPOSITORY = Object.freeze({ repository: 'demo' });
const OPEN_FIXTURE_COMMAND = 'remotish.demo.openFixture';

function repositoryRequest(): RemotishRepositoryRequest {
  return {
    provider: PROVIDER_ID,
    repository: REPOSITORY,
  };
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<RemotishAdapterProviderV1> {
  const provider: RemotishAdapterProviderV1 = {
    apiVersion: REMOTISH_ADAPTER_PROVIDER_API_VERSION,
    id: PROVIDER_ID,
    displayName: 'Fixture Provider',
    validateRepository(repository) {
      const keys = Object.keys(repository).sort();
      if (keys.length !== 1 || keys[0] !== 'repository' || repository.repository !== 'demo') {
        throw new Error('Fixture provider expects repository=demo only.');
      }
    },
    createAdapter() {
      return new FixtureAdapter();
    },
    async restoreWorkspace() {
      return repositoryRequest();
    },
  };

  const openFixture = vscode.commands.registerCommand(OPEN_FIXTURE_COMMAND, () =>
    vscode.commands.executeCommand(REMOTISH_OPEN_REPOSITORY_COMMAND, {
      version: REMOTISH_REPOSITORY_COMMAND_VERSION,
      ...repositoryRequest(),
    } satisfies RemotishRepositoryCommandV1),
  );
  context.subscriptions.push(openFixture);

  return provider;
}
