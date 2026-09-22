import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  REMOTISH_ENSURE_REPOSITORY_COMMAND,
  REMOTISH_REPOSITORY_COMMAND_VERSION,
} from '@remotish/adapter-sdk';
import { createStableWorkspaceId } from '@remotish/vscode';
import * as vscode from 'vscode';

import { activate as activateFixtureProvider } from '../../extensions/fixture-provider/build/extension.js';

const manifest = JSON.parse(
  await readFile(new URL('../../extensions/fixture-provider/package.json', import.meta.url)),
);

export const FIXTURE_REQUEST = Object.freeze({
  version: REMOTISH_REPOSITORY_COMMAND_VERSION,
  provider: 'fixture-provider',
  repository: Object.freeze({ repository: 'demo' }),
});

export const FIXTURE_WORKSPACE_ID = await createStableWorkspaceId(
  'fixture-provider',
  'fixture/demo',
);

export function installFixtureProvider() {
  const context = { subscriptions: [] };
  const extension = vscode.__test.installExtension({
    id: `${manifest.publisher}.${manifest.name}`,
    packageJSON: manifest,
    activate: () => activateFixtureProvider(context),
  });
  return {
    extension,
    dispose() {
      for (const disposable of [...context.subscriptions].reverse()) {
        disposable.dispose();
      }
    },
  };
}

export async function prepareFixtureRepository() {
  const prepared = await vscode.commands.executeCommand(
    REMOTISH_ENSURE_REPOSITORY_COMMAND,
    FIXTURE_REQUEST,
  );
  assert.equal(prepared.workspaceId, FIXTURE_WORKSPACE_ID);
  assert.equal(prepared.uri, `remotish://${FIXTURE_WORKSPACE_ID}/`);
  return prepared;
}
