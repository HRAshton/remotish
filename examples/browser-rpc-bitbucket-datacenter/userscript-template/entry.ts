import type { GmStorage } from '../../../extensions/browser-rpc-provider/src/transport/gm-mailbox.js';
import {
  BrowserRpcUserscriptEndpoint,
  BrowserRpcUserscriptHostRelay,
} from '../../../extensions/browser-rpc-provider/src/transport/userscript.js';
import { importBridgeKey } from '../../../extensions/browser-rpc-provider/src/transport/wire.js';
import { createBitbucketDataCenterEndpoint } from '../src/endpoint.js';

// Copy this file and metadata.txt to ../local/, then configure the exact Code-OSS and
// Bitbucket Data Center origins plus the same customer-generated key set in the provider.
const hostOrigin = 'https://code.example.invalid';
const bitbucketOrigin = 'https://bitbucket.example.invalid';
const pairingKey = 'REPLACE_WITH_YOUR_OWN_43_CHARACTER_BASE64URL_KEY';
const tokenPrefix = 'remotish.bitbucket-datacenter.token.v1.';

declare const GM_getValue: GmStorage['getValue'];
declare const GM_info: { readonly sandboxMode: string };
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
  if (typeof GM_info === 'undefined' || GM_info.sandboxMode !== 'dom') {
    console.error('Remotish userscript requires Tampermonkey isolated DOM sandbox.');
    return;
  }
  const origin = globalThis.location.origin;
  if (origin !== hostOrigin && origin !== bitbucketOrigin) {
    return;
  }
  const key = await importBridgeKey(pairingKey);
  if (origin === hostOrigin) {
    const relay = new BrowserRpcUserscriptHostRelay(storage, key);
    globalThis.addEventListener('pagehide', () => relay.dispose(), { once: true });
    return;
  }

  let target = '';
  const handler = createBitbucketDataCenterEndpoint(
    globalThis.location.href,
    bitbucketOrigin,
    async () => {
      const value = await GM_getValue(`${tokenPrefix}${target}`);
      return typeof value === 'string' ? value : undefined;
    },
  );
  if (!handler) {
    return;
  }
  target = handler.target;
  GM_registerMenuCommand('Set Bitbucket Data Center access token', () => {
    const value = globalThis.prompt('Bitbucket Data Center access token (blank removes it):');
    if (value === null) {
      return;
    }
    const change = value.trim()
      ? GM_setValue(`${tokenPrefix}${target}`, value.trim())
      : GM_deleteValue(`${tokenPrefix}${target}`);
    void Promise.resolve(change).catch(() => {
      console.error('Could not update the Bitbucket Data Center token in userscript storage.');
    });
  });
  const endpoint = new BrowserRpcUserscriptEndpoint(storage, key, handler);
  await endpoint.start();
  globalThis.addEventListener(
    'pagehide',
    () => {
      void endpoint.dispose().catch(() => {
        console.error('Could not close the Bitbucket Data Center endpoint cleanly.');
      });
    },
    { once: true },
  );
}

void main().catch(() => {
  // Never log the pairing key, token, request, response, or repository metadata.
  console.error(
    'Bitbucket Data Center Browser RPC userscript did not start. Check local configuration.',
  );
});
