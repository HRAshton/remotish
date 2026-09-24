import { decodeRpcSession, RpcAdapter } from '@remotish/adapter-rpc';
import {
  REMOTISH_ADAPTER_PROVIDER_API_VERSION,
  type RemotishAdapterProviderV1,
  RemotishError,
} from '@remotish/adapter-sdk';
import * as vscode from 'vscode';
import { BrowserRpcEndpointBroker } from './broker.js';
import { decodeBrowserRpcRepository } from './target.js';
import { BrowserRpcHostTransport } from './transport/host.js';
import { importBridgeKey } from './transport/wire.js';

const PROVIDER_ID = 'browser-rpc';
const BRIDGE_KEY_SECRET = 'remotish.browserRpc.bridgeKey.v1';
const CONFIGURE_COMMAND = 'remotish.browserRpc.configureBridge';

/** Construct the static provider over one session-local broker. */
export function createBrowserRpcProvider(
  broker: BrowserRpcEndpointBroker,
  connect: () => Promise<void> = async () => {},
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
      await connect();
      const endpoint = await broker.waitFor(target);
      const capabilities = JSON.stringify(decodeRpcSession(endpoint.session).capabilities);
      // Every call resolves a live endpoint, so tab reloads can recover without retrying writes.
      // A different capability contract cannot be routed through an existing synchronous adapter.
      return new RpcAdapter(
        {
          async request(request, options) {
            const current = broker.find(target) ?? (await broker.waitFor(target, options));
            if (JSON.stringify(decodeRpcSession(current.session).capabilities) !== capabilities) {
              throw new RemotishError('UNSUPPORTED', 'Browser RPC endpoint capabilities changed.');
            }
            return current.transport.request(request, options);
          },
        },
        endpoint.session,
      );
    },
  };
}

/** Activation does not pair or connect; a repository request starts the transport on demand. */
export function activate(context: vscode.ExtensionContext): RemotishAdapterProviderV1 {
  const broker = new BrowserRpcEndpointBroker();
  let transport: BrowserRpcHostTransport | undefined;
  let connecting: Promise<void> | undefined;
  let pairingGeneration = 0;
  const connect = async () => {
    if (transport) {
      return;
    }
    if (!connecting) {
      connecting = (async () => {
        const generation = pairingGeneration;
        const stored = await context.secrets.get(BRIDGE_KEY_SECRET);
        if (!stored) {
          throw new RemotishError(
            'UNAUTHORIZED',
            'Configure the Browser RPC bridge pairing key before opening a repository.',
          );
        }
        const key = await importBridgeKey(stored);
        const next = new BrowserRpcHostTransport(broker, key);
        try {
          await next.start();
          if (generation !== pairingGeneration) {
            throw new RemotishError('OFFLINE', 'Browser RPC pairing changed during connection.');
          }
          transport = next;
        } catch (error) {
          next.dispose();
          throw error;
        }
      })();
    }
    try {
      await connecting;
    } finally {
      connecting = undefined;
    }
  };
  const configure = vscode.commands.registerCommand(
    CONFIGURE_COMMAND,
    async (supplied?: unknown) => {
      const value =
        typeof supplied === 'string'
          ? supplied
          : await vscode.window.showInputBox({
              prompt: 'Enter the 256-bit Browser RPC userscript pairing key',
              password: true,
              ignoreFocusOut: true,
            });
      if (value === undefined) {
        throw new RemotishError('CANCELLED', 'Browser RPC pairing was cancelled.');
      }
      await importBridgeKey(value);
      await context.secrets.store(BRIDGE_KEY_SECRET, value);
      pairingGeneration += 1;
      transport?.dispose();
      transport = undefined;
    },
  );
  context.subscriptions.push(configure, {
    dispose() {
      transport?.dispose();
      broker.dispose();
    },
  });
  return createBrowserRpcProvider(broker, connect);
}
