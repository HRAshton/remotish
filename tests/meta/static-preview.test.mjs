import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { prepareStaticPreview } from '../../scripts/prepare-static-preview.mjs';

test('prepares a Code-OSS distribution with browser extensions', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'remotish-preview-'));
  try {
    const dist = resolve(root, 'dist');
    const extension = resolve(root, 'extension');
    await mkdir(resolve(dist, 'extensions'), { recursive: true });
    await mkdir(resolve(extension, 'dist'), { recursive: true });
    await writeFile(
      resolve(dist, 'index.html'),
      '<meta http-equiv="Content-Security-Policy" content="connect-src \'self\';">',
    );
    await writeFile(
      resolve(dist, 'additional-extensions.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        extensions: [{ id: 'upstream.keep', path: 'extensions/upstream.keep/' }],
      })}\n`,
    );
    await writeFile(
      resolve(dist, 'extensions.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        extensions: [{ id: 'upstream.keep', path: 'extensions/upstream.keep/' }],
      })}\n`,
    );
    await writeFile(
      resolve(extension, 'package.json'),
      `${JSON.stringify({
        publisher: 'hrashton',
        name: 'preview-test',
        version: '1.0.0',
        browser: './dist/extension.js',
        license: '0BSD',
      })}\n`,
    );
    await writeFile(resolve(extension, 'dist/extension.js'), 'export {};\n');

    await prepareStaticPreview({
      dist,
      extensionPaths: [pathToFileURL(`${extension}/`)],
    });

    const additional = JSON.parse(
      await readFile(resolve(dist, 'additional-extensions.json'), 'utf8'),
    );
    assert.deepEqual(additional.extensions, [
      { id: 'hrashton.preview-test', path: 'extensions/hrashton.preview-test/' },
      { id: 'upstream.keep', path: 'extensions/upstream.keep/' },
    ]);

    const index = JSON.parse(await readFile(resolve(dist, 'extensions.json'), 'utf8'));
    const installed = index.extensions.find((item) => item.id === 'hrashton.preview-test');
    assert.equal(installed.version, '1.0.0');
    assert.equal(
      await readFile(resolve(dist, 'extensions/hrashton.preview-test/dist/extension.js'), 'utf8'),
      'export {};\n',
    );
    assert.match(
      await readFile(resolve(dist, 'index.html'), 'utf8'),
      /connect-src 'self' https:\/\/api\.github\.com;/u,
    );
    assert.equal(
      await readFile(resolve(dist, 'robots.txt'), 'utf8'),
      'User-agent: *\nDisallow: /\n',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
