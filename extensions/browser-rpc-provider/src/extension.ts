import { RpcAdapter } from '@remotish/adapter-rpc';
import {
  REMOTISH_ADAPTER_PROVIDER_API_VERSION,
  type RemotishAdapterProviderV1,
} from '@remotish/adapter-sdk';
import type * as vscode from 'vscode';
import { BrowserRpcEndpointBroker } from './broker.js';
import { decodeBrowserRpcRepository } from './target.js';

const PROVIDER_ID = 'browser-rpc';

/** Construct the static provider over one session-local broker. */
export function createBrowserRpcProvider(
  broker: BrowserRpcEndpointBroker,
): RemotishAdapterProviderV1 {
  return {
    apiVersion: REMOTISH_ADAPTER_PROVIDER_API_VERSION,
    id: PROVIDER_ID,
    displayName: 'Browser RPC',
    validateRepository(repository) {
      decodeBrowserRpcRepository(repository);
    },
    async createAdapter(repository) {
      const target = decodeBrowserRpcRepository(repository);
      const endpoint = await broker.waitFor(target);
      return new RpcAdapter(endpoint.transport, endpoint.session);
    },
  };
}

/** Activation creates no connection; the browser transport is added in the next PR. */
export function activate(context: vscode.ExtensionContext): RemotishAdapterProviderV1 {
  const broker = new BrowserRpcEndpointBroker();
  context.subscriptions.push(broker);
  return createBrowserRpcProvider(broker);
}
