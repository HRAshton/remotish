import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import { REMOTISH_REPOSITORY_COMMAND_VERSION } from '@remotish/adapter-sdk';
import {
  REMOTISH_EXPORT_DIAGNOSTICS_COMMAND,
  RemotishDiagnostics,
  RemotishProviderHost,
} from '@remotish/vscode';
import * as vscode from 'vscode';

function createMemento() {
  const values = new Map();
  return {
    get(key, fallback) {
      return values.has(key) ? values.get(key) : fallback;
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

function createContext() {
  return {
    extension: {
      packageJSON: {
        version: '0.1.0-test',
      },
    },
    workspaceState: createMemento(),
    globalState: createMemento(),
    storageUri: vscode.Uri.from({
      scheme: 'test-storage',
      authority: 'workspace',
      path: '/diagnostics',
    }),
    globalStorageUri: vscode.Uri.from({
      scheme: 'test-storage',
      authority: 'global',
      path: '/diagnostics',
    }),
    subscriptions: [],
  };
}

function disposeContext(context) {
  for (const disposable of [...context.subscriptions].reverse()) {
    disposable.dispose();
  }
}

function installProvider() {
  return vscode.__test.installExtension({
    id: 'example.diagnostics-provider',
    packageJSON: {
      version: '9.8.7',
      remotish: {
        provider: true,
        apiVersion: 1,
        id: 'diagnostics-provider',
        displayName: 'Diagnostics Provider',
      },
    },
    async activate() {
      return {
        apiVersion: 1,
        id: 'diagnostics-provider',
        displayName: 'Diagnostics Provider',
        validateRepository() {},
        createAdapter() {
          return new FixtureAdapter();
        },
      };
    },
  });
}

test('diagnostics report excludes repository-specific and secret-looking values', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());
  installProvider();

  const context = createContext();
  const providers = new RemotishProviderHost(context);
  const diagnostics = new RemotishDiagnostics(context, providers);
  context.subscriptions.push(providers, diagnostics);
  t.after(() => disposeContext(context));

  const secrets = [
    'customer-payroll-repository',
    'feature/private-acquisition',
    'Bearer ghp_SUPER_SECRET',
    'src/payroll/acquisitions-2027.md',
    'alice@company.example',
  ];

  await providers.ensureRepository({
    version: REMOTISH_REPOSITORY_COMMAND_VERSION,
    provider: 'diagnostics-provider',
    repository: {
      repository: secrets[0],
      branchHint: secrets[1],
      note: secrets[2],
      pathHint: secrets[3],
      ownerEmail: secrets[4],
    },
  });

  const report = await diagnostics.collect();
  const serialized = JSON.stringify(report);

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.host.remotishVersion, '0.1.0-test');
  assert.equal(report.host.vscodeVersion, '1.139.1');
  assert.equal(report.workspaces.active, 1);
  assert.equal(report.providers.length, 1);
  assert.equal(report.providers[0]?.id, 'diagnostics-provider');
  assert.equal(report.providers[0]?.extensionVersion, '9.8.7');
  assert.equal(report.providers[0]?.active, true);

  for (const secret of secrets) {
    assert.equal(serialized.includes(secret), false, `diagnostics leaked: ${secret}`);
  }
});

test('export command writes the collected report as local JSON', async (t) => {
  vscode.__test.reset();
  t.after(() => vscode.__test.reset());
  installProvider();

  const context = createContext();
  const providers = new RemotishProviderHost(context);
  const diagnostics = new RemotishDiagnostics(context, providers);
  context.subscriptions.push(providers, diagnostics);
  t.after(() => disposeContext(context));

  const target = vscode.Uri.from({
    scheme: 'test-storage',
    authority: 'exports',
    path: '/remotish-diagnostics.json',
  });
  vscode.__test.saveDialogResponses.push(target);

  await vscode.commands.executeCommand(REMOTISH_EXPORT_DIAGNOSTICS_COMMAND);

  const exported = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(target)));
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.host.remotishVersion, '0.1.0-test');
  assert.equal(exported.storage.backend, 'storageUri');
  assert.equal(vscode.__test.infoMessages.at(-1), 'Remotish diagnostics exported.');
});
