import type { GmStorage } from '../src/transport/gm-mailbox.js';
import {
  BrowserRpcUserscriptEndpoint,
  BrowserRpcUserscriptHostRelay,
} from '../src/transport/userscript.js';
import { importBridgeKey } from '../src/transport/wire.js';
import { createEndpoint } from './customer-endpoint.js';

// Copy this template to an untracked local directory. Set these values and the matching
// @match entries in metadata.txt to your own exact Code-OSS and endpoint origins.
const hostOrigin = 'https://code.example.invalid';
const endpointOrigins = ['https://scm.example.invalid'];
const pairingKey = 'REPLACE_WITH_YOUR_OWN_43_CHARACTER_BASE64URL_KEY';

declare const GM_getValue: GmStorage['getValue'];
declare const GM_info: { readonly sandboxMode: string };
declare const GM_setValue: GmStorage['setValue'];
declare const GM_deleteValue: GmStorage['deleteValue'];
declare const GM_listValues: GmStorage['listValues'];
declare const GM_addValueChangeListener: GmStorage['addValueChangeListener'];
declare const GM_removeValueChangeListener: GmStorage['removeValueChangeListener'];

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
  const key = await importBridgeKey(pairingKey);
  const origin = globalThis.location.origin;
  if (origin === hostOrigin) {
    const relay = new BrowserRpcUserscriptHostRelay(storage, key);
    globalThis.addEventListener('pagehide', () => relay.dispose(), { once: true });
  } else if (endpointOrigins.includes(origin)) {
    const handler = createEndpoint();
    if (handler) {
      const endpoint = new BrowserRpcUserscriptEndpoint(storage, key, handler);
      await endpoint.start();
      globalThis.addEventListener(
        'pagehide',
        () => {
          // The browser may end the page before GM storage finishes; heartbeat expiry is fallback.
          endpoint.dispose().catch(() => {});
        },
        { once: true },
      );
    }
  }
}

main().catch(() => {
  // Do not expose pairing keys, packets, descriptors, or endpoint errors to page diagnostics.
  console.error('Browser RPC userscript did not start. Check local bridge configuration.');
});
