import { FixtureAdapter } from '@remotish/adapter-fixture';
import { RemotishWorkspace } from '@remotish/core';
import {
  createStableWorkspaceId,
  createWorkingUri,
  ProviderRegistry,
  RemotishVsCodeHost,
  StorageUriWorkspaceStorage,
} from '@remotish/vscode';
import {
  REMOTISH_EXTENSION_API_VERSION,
  type RemotishExtensionApiV1,
  type RemotishOpenRequest,
} from '@remotish/vscode/provider-api';
import { RemotishHistoryHost } from '@remotish/vscode-history';
import * as vscode from 'vscode';

const WORKSPACE_ID = 'fixture-demo';
const SECRET_DESCRIPTOR_KEYS = new Set([
  'access_token',
  'api_token',
  'authorization',
  'client_secret',
  'credential',
  'credentials',
  'oauth_token',
  'password',
  'private_key',
  'refresh_token',
  'secret',
  'session',
  'session_id',
  'token',
]);

export async function activate(
  context: vscode.ExtensionContext,
): Promise<RemotishExtensionApiV1> {
  const storageRoot = context.storageUri ?? context.globalStorageUri;
  const hostStorage = new StorageUriWorkspaceStorage(storageRoot, 'host');
  const demoStorage = new StorageUriWorkspaceStorage(storageRoot, 'demo-fixture');

  const host = new RemotishVsCodeHost();
  const providers = new ProviderRegistry();
  const history = new RemotishHistoryHost(host);
  context.subscriptions.push(host, history);

  const api: RemotishExtensionApiV1 = {
    version: REMOTISH_EXTENSION_API_VERSION,

    registerProvider(provider) {
      const registration = providers.register(provider);
      context.subscriptions.push(registration);
      return registration;
    },

    async openRepository(request) {
      validateOpenRequest(request);
      const provider = providers.require(request.provider);
      const adapter = await provider.createAdapter(request.repository);
      const candidate = await RemotishWorkspace.open(adapter, hostStorage);
      const requestedBranch = request.branch?.trim();

      if (requestedBranch) {
        await candidate.switchBranch(requestedBranch);
      }

      const workspaceId = await createStableWorkspaceId(
        provider.id,
        candidate.repositoryInfo.id,
      );
      const existing = host.registry.get(workspaceId);
      let workspace = existing?.workspace;

      if (!workspace) {
        const unregister = host.registry.register(workspaceId, candidate);
        context.subscriptions.push(unregister);
        workspace = candidate;
      } else if (requestedBranch && workspace.branch !== requestedBranch) {
        await workspace.switchBranch(requestedBranch);
      }

      const uri = createWorkingUri(workspaceId, request.path ?? '');
      await vscode.commands.executeCommand('vscode.openFolder', uri, false);

      return {
        workspaceId,
        repositoryId: workspace.repositoryInfo.id,
        branch: workspace.branch,
        uri: uri.toString(),
      };
    },
  };

  const demoWorkspace = await RemotishWorkspace.open(new FixtureAdapter(), demoStorage);
  const unregisterDemo = host.registry.register(WORKSPACE_ID, demoWorkspace);
  const openFixture = vscode.commands.registerCommand('remotish.demo.openFixture', () =>
    vscode.commands.executeCommand('vscode.openFolder', createWorkingUri(WORKSPACE_ID), false),
  );
  context.subscriptions.push(unregisterDemo, openFixture);

  return api;
}

function validateOpenRequest(request: RemotishOpenRequest): void {
  if (!request.provider.trim()) {
    throw new Error('Remotish open request requires a provider id.');
  }
  if (
    !request.repository ||
    typeof request.repository !== 'object' ||
    Array.isArray(request.repository)
  ) {
    throw new Error('Remotish open request requires a repository descriptor object.');
  }

  const entries = Object.entries(request.repository);
  if (entries.length === 0) {
    throw new Error('Remotish repository descriptor must not be empty.');
  }

  for (const [key, value] of entries) {
    const normalizedKey = key.trim().toLowerCase().replace(/[-\s]/gu, '_');
    if (!key.trim() || typeof value !== 'string' || !value.trim()) {
      throw new Error('Remotish repository descriptor keys and values must be non-empty strings.');
    }
    if (SECRET_DESCRIPTOR_KEYS.has(normalizedKey)) {
      throw new Error(`Remotish repository descriptor must not contain secret field "${key}".`);
    }
  }

  if (request.branch !== undefined && !request.branch.trim()) {
    throw new Error('Requested branch must not be empty.');
  }
}
