const assert = require('node:assert/strict');
const test = require('node:test');
const fc = require('fast-check');

const PROPERTY_PARAMETERS = { numRuns: 500, seed: 0x5eedc0de };
const target = 'https://example.com/owner/repository';
const codeUnit = fc.integer({ min: 0, max: 0xffff }).map((value) => String.fromCharCode(value));
const branch = fc.string({ unit: codeUnit, maxLength: 64 });

test('bootstrap URI rejects invalid branches or round-trips accepted branches exactly', async () => {
  const { createBrowserRpcBootstrapUri, decodeBrowserRpcBootstrapUri } = await import(
    '../../extensions/browser-rpc-provider/build/bootstrap-uri.js'
  );

  fc.assert(
    fc.property(branch, (value) => {
      let uri;
      try {
        uri = createBrowserRpcBootstrapUri({ target, branch: value });
      } catch (error) {
        assert.equal(error?.code, 'INVALID_REQUEST');
        return;
      }

      assert.deepEqual(decodeBrowserRpcBootstrapUri(uri), { target, branch: value });
    }),
    PROPERTY_PARAMETERS,
  );
});
