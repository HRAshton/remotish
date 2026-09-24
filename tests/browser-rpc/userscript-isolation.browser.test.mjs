import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../../', import.meta.url));
const metadataPaths = [
  'extensions/browser-rpc-provider/userscript-template/metadata.txt',
  'examples/browser-rpc-bitbucket/userscript-template/metadata.txt',
];

test('both userscript templates request only the isolated DOM sandbox', async () => {
  for (const path of metadataPaths) {
    const metadata = await readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
    assert.deepEqual(
      metadata.match(/^\/\/ @sandbox\s+\S+\s*$/gmu)?.map((line) => line.trim()),
      ['// @sandbox      DOM'],
      path,
    );
  }
});

test('both bundled userscripts refuse raw, js, and missing sandbox modes before key import', async () => {
  for (const [path, origin] of [
    ['extensions/browser-rpc-provider/userscript-template/entry.ts', 'https://code.example.test'],
    ['examples/browser-rpc-bitbucket/userscript-template/entry.ts', 'https://bitbucket.org'],
  ]) {
    const entry = fileURLToPath(new URL(`../../${path}`, import.meta.url));
    const contents = (await readFile(entry, 'utf8'))
      .replaceAll('.invalid', '.test')
      .replace('REPLACE_WITH_YOUR_OWN_43_CHARACTER_BASE64URL_KEY', 'A'.repeat(43));
    const { outputFiles } = await build({
      stdin: { contents, resolveDir: dirname(entry), sourcefile: 'entry.ts', loader: 'ts' },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
    });
    for (const sandboxMode of ['raw', 'js', undefined]) {
      const errors = [];
      let keyImports = 0;
      runInNewContext(outputFiles[0].text, {
        GM_info: sandboxMode === undefined ? undefined : { sandboxMode },
        location: { origin, href: `${origin}/acme/widgets` },
        crypto: {
          subtle: {
            importKey: () => {
              keyImports += 1;
              return Promise.resolve({});
            },
          },
        },
        atob,
        btoa,
        console: { error: (message) => errors.push(message) },
      });
      await new Promise(setImmediate);
      assert.deepEqual(errors, ['Remotish userscript requires Tampermonkey isolated DOM sandbox.']);
      assert.equal(keyImports, 0, `${path}: ${sandboxMode}`);
    }
  }
});

test('Chromium isolated userscript world does not see page-patched credential globals', async () => {
  const { outputFiles } = await build({
    stdin: {
      resolveDir: root,
      sourcefile: 'userscript-isolation-probe.ts',
      contents: `
        import { importBridgeKey } from './extensions/browser-rpc-provider/src/transport/wire.ts';
        import { createBitbucketEndpoint } from './examples/browser-rpc-bitbucket/src/endpoint.ts';
        globalThis.__remotishProbe = (async () => {
          const prompted = globalThis.prompt('test token');
          const key = await importBridgeKey('${'A'.repeat(43)}');
          const endpoint = createBitbucketEndpoint(globalThis.location.href, () => prompted);
          if (!endpoint) throw new Error('Bitbucket endpoint did not start');
          const repository = await endpoint.handle(
            { version: 1, operation: 'getRepository', payload: {} },
            new AbortController().signal,
          );
          return { keyExtractable: key.extractable, repository };
        })();
      `,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const network = [];
    const authorizations = [];
    page.on('request', (request) => network.push(`${request.method()} ${request.url()}`));
    page.on('requestfailed', (request) =>
      network.push(`FAILED ${request.url()}: ${request.failure()?.errorText}`),
    );
    await page.route('https://bitbucket.org/acme/widgets', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' }),
    );
    await page.route('https://api.bitbucket.org/**', (route) => {
      authorizations.push(route.request().headers().authorization);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'access-control-allow-origin': 'https://bitbucket.org',
          'access-control-allow-headers': 'authorization',
          'access-control-allow-methods': 'GET',
        },
        body: JSON.stringify({
          uuid: '{585074de-7b60-4fd1-81ed-e0bc7fafbda5}',
          name: 'Widgets',
          mainbranch: { name: 'main' },
        }),
      });
    });
    await page.route('https://api.bitbucket.org/redirect', (route) =>
      route.fulfill({ status: 301, headers: { location: 'https://media.example/file' } }),
    );
    await page.goto('https://bitbucket.org/acme/widgets');
    await page.evaluate(() => {
      globalThis.pageIntercepts = { prompt: 0, fetch: 0, crypto: 0 };
      globalThis.prompt = () => {
        globalThis.pageIntercepts.prompt += 1;
        return 'stolen';
      };
      globalThis.fetch = () => {
        globalThis.pageIntercepts.fetch += 1;
        return Promise.resolve('stolen');
      };
      globalThis.crypto.subtle.importKey = () => {
        globalThis.pageIntercepts.crypto += 1;
        return Promise.resolve('stolen');
      };
    });
    assert.deepEqual(
      await page.evaluate(async () => {
        const values = [
          globalThis.prompt(),
          await globalThis.fetch(),
          await globalThis.crypto.subtle.importKey(),
        ];
        const seen = { ...globalThis.pageIntercepts };
        globalThis.pageIntercepts = { prompt: 0, fetch: 0, crypto: 0 };
        return { values, seen };
      }),
      { values: ['stolen', 'stolen', 'stolen'], seen: { prompt: 1, fetch: 1, crypto: 1 } },
    );
    page.on('dialog', (dialog) => dialog.accept('isolated-test-token'));

    const cdp = await page.context().newCDPSession(page);
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id,
      worldName: 'remotish-userscript-test',
    });
    await cdp.send('Runtime.evaluate', {
      contextId: executionContextId,
      expression: outputFiles[0].text,
    });
    const result = await cdp.send('Runtime.evaluate', {
      contextId: executionContextId,
      expression: 'globalThis.__remotishProbe',
      awaitPromise: true,
      returnByValue: true,
    });
    assert.equal(
      result.exceptionDetails,
      undefined,
      JSON.stringify({
        network,
        intercepts: await page.evaluate(() => globalThis.pageIntercepts),
      }),
    );
    assert.equal(result.result.value.keyExtractable, false);
    assert.equal(result.result.value.repository.name, 'Widgets');
    assert.ok(authorizations.includes('Bearer isolated-test-token'));
    const redirect = await cdp.send('Runtime.evaluate', {
      contextId: executionContextId,
      expression:
        "fetch('https://api.bitbucket.org/redirect', { redirect: 'manual' }).then((response) => ({ type: response.type, status: response.status }))",
      awaitPromise: true,
      returnByValue: true,
    });
    assert.equal(redirect.exceptionDetails, undefined);
    assert.deepEqual(redirect.result.value, { type: 'opaqueredirect', status: 0 });
    assert.deepEqual(await page.evaluate(() => globalThis.pageIntercepts), {
      prompt: 0,
      fetch: 0,
      crypto: 0,
    });
    assert.equal(await page.evaluate(() => globalThis.__remotishProbe), undefined);
  } finally {
    await browser.close();
  }
});
