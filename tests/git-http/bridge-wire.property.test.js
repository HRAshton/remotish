const assert = require('node:assert/strict');
const test = require('node:test');
const fc = require('fast-check');

const PROPERTY_PARAMETERS = { numRuns: 500, seed: 0x5eedc0de };
const HEX = [...'0123456789abcdef'];
const printableAscii = fc.integer({ min: 32, max: 126 }).map((value) => String.fromCharCode(value));
const id = fc.string({ unit: fc.constantFrom(...HEX), minLength: 32, maxLength: 32 });
const smallText = fc.string({ unit: printableAscii, maxLength: 64 });
const headers = fc
  .dictionary(
    fc.string({ unit: printableAscii, maxLength: 16 }),
    fc.string({ unit: printableAscii, maxLength: 64 }),
    { maxKeys: 4, noNullPrototype: true },
  )
  .map((value) => ({ ...value }));
const failureCode = fc.constantFrom(
  'OFFLINE',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'UNSUPPORTED',
  'INVALID_REQUEST',
  'UNKNOWN',
);

const frame = fc.oneof(
  fc.tuple(id, id).map(([hostId, frameId]) => ({
    version: 1,
    kind: 'hello-request',
    hostId,
    id: frameId,
  })),
  fc.tuple(id, id, id).map(([hostId, frameId, sessionId]) => ({
    version: 1,
    kind: 'hello',
    hostId,
    id: frameId,
    sessionId,
  })),
  fc
    .tuple(id, id, id, smallText, smallText, headers, smallText)
    .map(([hostId, frameId, sessionId, url, method, frameHeaders, body]) => ({
      version: 1,
      kind: 'request',
      hostId,
      id: frameId,
      sessionId,
      url,
      method,
      headers: frameHeaders,
      body,
    })),
  fc
    .tuple(id, id, id, fc.integer({ min: 100, max: 599 }), headers, smallText)
    .map(([hostId, frameId, sessionId, status, frameHeaders, body]) => ({
      version: 1,
      kind: 'response',
      hostId,
      id: frameId,
      sessionId,
      status,
      headers: frameHeaders,
      body,
    })),
  fc.tuple(id, id, id, failureCode).map(([hostId, frameId, sessionId, code]) => ({
    version: 1,
    kind: 'failure',
    hostId,
    id: frameId,
    sessionId,
    code,
  })),
  fc.tuple(id, id, id).map(([hostId, frameId, sessionId]) => ({
    version: 1,
    kind: 'cancel',
    hostId,
    id: frameId,
    sessionId,
  })),
);

test('bridge byte codec round-trips arbitrary bounded binary bodies', async () => {
  const { decodeBytes, encodeBytes } = await import(
    '../../extensions/git-http-provider/build/bridge-wire.js'
  );

  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
      assert.deepEqual(decodeBytes(encodeBytes(bytes)), bytes);
    }),
    PROPERTY_PARAMETERS,
  );
});

test('authenticated bridge frames round-trip through encryption and validation', async () => {
  const { decrypt, encrypt, importKey } = await import(
    '../../extensions/git-http-provider/build/bridge-wire.js'
  );
  const key = await importKey(Buffer.alloc(32, 7).toString('base64url'));

  await fc.assert(
    fc.asyncProperty(frame, async (value) => {
      assert.deepEqual(await decrypt(key, await encrypt(key, value)), value);
    }),
    { ...PROPERTY_PARAMETERS, numRuns: 100 },
  );
});
