import type { GmStorage } from '../../../extensions/browser-rpc-provider/src/transport/gm-mailbox.js';
import {
  BrowserRpcUserscriptEndpoint,
  BrowserRpcUserscriptHostRelay,
} from '../../../extensions/browser-rpc-provider/src/transport/userscript.js';
import { importBridgeKey } from '../../../extensions/browser-rpc-provider/src/transport/wire.js';
import { createBitbucketEndpoint } from '../src/endpoint.js';

// Copy this file and metadata.txt to ../local/, then configure your exact Code-OSS origin
// and the same customer-generated key set in the Browser RPC provider extension.
const hostOrigin = 'https://code.example.invalid';
const pairingKey = 'REPLACE_WITH_YOUR_OWN_43_CHARACTER_BASE64URL_KEY';
const tokenPrefix = 'remotish.bitbucket.token.v1.';

declare const GM_getValue: GmStorage['getValue'];
declare const GM_setValue: GmStorage['setValue'];
declare const GM_deleteValue: GmStorage['deleteValue'];
declare const GM_listValues: GmStorage['listValues'];
declare const GM_addValueChangeListener: GmStorage['addValueChangeListener'];
declare const GM_removeValueChangeListener: GmStorage['removeValueChangeListener'];
declare function GM_registerMenuCommand(label: string, callback: () => void): void;

const storage: GmStorage = {
  getValue: (name) => GM_getValue(name),
  setValue: (name, value) => GM_setValue(name, value),
  deleteValue: (name) => GM_deleteValue(name),
  listValues: () => GM_listValues(),
  addValueChangeListener: (name, callback) => GM_addValueChangeListener(name, callback),
  removeValueChangeListener: (id) => GM_removeValueChangeListener(id),
};

async function main(): Promise<void> {
  const origin = globalThis.location.origin;
  if (origin !== hostOrigin && origin !== 'https://bitbucket.org') {
    return;
  }
  const key = await importBridgeKey(pairingKey);
  if (origin === hostOrigin) {
    const relay = new BrowserRpcUserscriptHostRelay(storage, key);
    globalThis.addEventListener('pagehide', () => relay.dispose(), { once: true });
    return;
  }

  let target = '';
  const handler = createBitbucketEndpoint(globalThis.location.href, async () => {
    const value = await GM_getValue(`${tokenPrefix}${target}`);
    return typeof value === 'string' ? value : undefined;
  });
  if (!handler) {
    return;
  }
  target = handler.target;
  GM_registerMenuCommand('Set read-only Bitbucket repository token', () => {
    const value = globalThis.prompt('Bitbucket repository access token (blank removes it):');
    if (value === null) {
      return;
    }
    const change = value.trim()
      ? GM_setValue(`${tokenPrefix}${target}`, value.trim())
      : GM_deleteValue(`${tokenPrefix}${target}`);
    void Promise.resolve(change).catch(() => {
      console.error('Could not update the Bitbucket token in userscript storage.');
    });
  });
  const endpoint = new BrowserRpcUserscriptEndpoint(storage, key, handler);
  await endpoint.start();
  globalThis.addEventListener(
    'pagehide',
    () => {
      void endpoint.dispose().catch(() => {
        console.error('Could not close the Bitbucket endpoint cleanly.');
      });
    },
    { once: true },
  );
}

void main().catch(() => {
  // Never log the pairing key, token, request, response, or repository metadata.
  console.error('Bitbucket Browser RPC userscript did not start. Check local configuration.');
});
