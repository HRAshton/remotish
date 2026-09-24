import { FixtureAdapter } from '@remotish/adapter-fixture';
import { decodeRpcRequest, encodeRpcFailure, encodeRpcSuccess } from '@remotish/adapter-rpc';
import { RemotishError } from '@remotish/adapter-sdk';
import * as vscode from 'vscode';

const CHANNEL = 'remotish-browser-rpc-v1';
export const BROWSER_RPC_SMOKE_TARGET = 'https://example.com/browser-rpc-smoke';

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid test bridge packet.');
  }
  return value as Record<string, unknown>;
}

function filePayload(value: unknown): { revision: string; path: string } {
  const data = record(value);
  if (typeof data.revision !== 'string' || typeof data.path !== 'string') {
    throw new Error('Invalid test bridge file request.');
  }
  return { revision: data.revision, path: data.path };
}

/** Packaged-extension smoke uses a deterministic, key-holding test endpoint, not a live SCM. */
export async function withBrowserRpcFixtureEndpoint(
  run: (target: string) => Promise<void>,
): Promise<void> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const keyString = base64Url(bytes);
  const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  await vscode.commands.executeCommand('remotish.browserRpc.configureBridge', keyString);
  const channel = new BroadcastChannel(CHANNEL);
  const endpointId = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const target = BROWSER_RPC_SMOKE_TARGET;
  const fixture = new FixtureAdapter();
  let failure: unknown;
  channel.onmessage = (event) => {
    receive(event.data).catch((error: unknown) => {
      failure = error;
    });
  };
  async function encryptFrame(frame: unknown): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(frame));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext),
    );
    return JSON.stringify({ version: 1, iv: base64Url(iv), ciphertext: base64Url(ciphertext) });
  }
  async function decryptFrame(raw: unknown): Promise<Record<string, unknown>> {
    if (typeof raw !== 'string') {
      throw new Error('Invalid test bridge packet.');
    }
    const packet = record(JSON.parse(raw));
    if (typeof packet.iv !== 'string' || typeof packet.ciphertext !== 'string') {
      throw new Error('Invalid test bridge packet.');
    }
    const binary = (value: string) =>
      Uint8Array.from(
        atob(
          value
            .replaceAll('-', '+')
            .replaceAll('_', '/')
            .padEnd(Math.ceil(value.length / 4) * 4, '='),
        ),
        (character) => character.charCodeAt(0),
      );
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: binary(packet.iv) },
      key,
      binary(packet.ciphertext),
    );
    return record(JSON.parse(new TextDecoder().decode(plaintext)));
  }
  async function receive(raw: unknown): Promise<void> {
    const frame = await decryptFrame(raw);
    if (frame.kind === 'hello' && typeof frame.hostId === 'string') {
      channel.postMessage(
        await encryptFrame({
          version: 1,
          kind: 'register',
          hostId: frame.hostId,
          endpointId,
          counter: 1,
          origin: 'https://example.com',
          target,
          session: { version: 1, capabilities: { commits: false } },
        }),
      );
    } else if (
      frame.kind === 'request' &&
      frame.endpointId === endpointId &&
      typeof frame.hostId === 'string' &&
      typeof frame.requestId === 'string'
    ) {
      const request = decodeRpcRequest(frame.request);
      let response: unknown;
      try {
        let result: unknown;
        switch (request.operation) {
          case 'getRepository':
            result = await fixture.getRepository();
            break;
          case 'getBranches':
            result = await fixture.getBranches();
            break;
          case 'readDirectory': {
            const payload = filePayload(request.payload);
            result = await fixture.readDirectory(payload.revision, payload.path);
            break;
          }
          case 'readFile': {
            const payload = filePayload(request.payload);
            result = await fixture.readFile(payload.revision, payload.path);
            break;
          }
          default:
            result = undefined;
        }
        response =
          result === undefined
            ? encodeRpcFailure('UNSUPPORTED')
            : encodeRpcSuccess(request.operation, result);
      } catch (error) {
        if (!(error instanceof RemotishError)) {
          throw error;
        }
        response = encodeRpcFailure(error.code);
      }
      channel.postMessage(
        await encryptFrame({
          version: 1,
          kind: 'response',
          hostId: frame.hostId,
          endpointId,
          requestId: frame.requestId,
          response,
        }),
      );
    }
  }
  try {
    await run(target);
    if (failure) {
      throw new Error(`Browser RPC test endpoint rejected transport traffic: ${String(failure)}`);
    }
  } finally {
    channel.close();
  }
}

export async function runBrowserRpcSmoke(): Promise<void> {
  await withBrowserRpcFixtureEndpoint(async (target) => {
    const prepared = await vscode.commands.executeCommand<{ readonly uri: string }>(
      'remotish.ensureRepository',
      { version: 1, provider: 'browser-rpc', repository: { target } },
    );
    if (!prepared?.uri.startsWith('remotish://browser-rpc-')) {
      throw new Error('Browser RPC did not prepare a canonical workspace.');
    }
    const root = vscode.Uri.parse(prepared.uri);
    const content = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(root, 'assets/sample.bin'),
    );
    if (content.join(',') !== '0,1,2,127,128,255') {
      throw new Error('Browser RPC filesystem did not preserve binary bytes.');
    }
  });
}
