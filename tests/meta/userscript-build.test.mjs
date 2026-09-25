import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('userscript builder requires isolated sandbox metadata and GM_info grant', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remotish-userscript-build-'));
  try {
    const entry = join(directory, 'entry.ts');
    const metadataFile = join(directory, 'metadata.txt');
    const output = join(directory, 'output.user.js');
    const metadata = (
      await readFile(
        new URL(
          '../../extensions/browser-rpc-provider/userscript-template/metadata.txt',
          import.meta.url,
        ),
        'utf8',
      )
    ).replaceAll('.invalid', '.test');
    await writeFile(entry, 'globalThis.remotishBuildTest = true;\n');
    for (const invalid of [
      metadata.replace(/^\/\/ @sandbox.*\r?\n/mu, ''),
      metadata.replace('@sandbox      DOM', '@sandbox      raw'),
      metadata.replace('@sandbox      DOM', '@sandbox      DOM\n// @sandbox      raw'),
      `${metadata.replace(/^\/\/ @sandbox.*\r?\n/mu, '')}\n// @sandbox      DOM\n`,
      metadata.replace(/^\/\/ @grant\s+GM_info\r?\n/mu, ''),
    ]) {
      await writeFile(metadataFile, invalid);
      const result = spawnSync(
        process.execPath,
        ['scripts/build-browser-rpc-userscript.mjs', entry, metadataFile, output],
        { cwd: root, encoding: 'utf8' },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /@sandbox DOM/u);
    }
    await writeFile(metadataFile, metadata);
    const valid = spawnSync(
      process.execPath,
      ['scripts/build-browser-rpc-userscript.mjs', entry, metadataFile, output],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(await readFile(output, 'utf8'), /^\/\/ ==UserScript==\r?\n\/\/ @name/mu);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('Bitbucket userscript builder requires scoped privileged publication metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remotish-bitbucket-userscript-build-'));
  try {
    const entry = join(directory, 'entry.ts');
    const metadataFile = join(directory, 'metadata.txt');
    const output = join(directory, 'output.user.js');
    const metadata = (
      await readFile(
        new URL(
          '../../examples/browser-rpc-bitbucket/userscript-template/metadata.txt',
          import.meta.url,
        ),
        'utf8',
      )
    ).replaceAll('.invalid', '.test');
    await writeFile(entry, 'void GM_xmlhttpRequest;\n');
    for (const invalid of [
      metadata.replace(/^\/\/ @grant\s+GM_xmlhttpRequest\r?\n/mu, ''),
      metadata.replace(/^\/\/ @connect\s+api\.bitbucket\.org\r?\n/mu, ''),
      metadata.replace('@connect      api.bitbucket.org', '@connect      evil.example'),
    ]) {
      await writeFile(metadataFile, invalid);
      const result = spawnSync(
        process.execPath,
        ['scripts/build-browser-rpc-userscript.mjs', entry, metadataFile, output],
        { cwd: root, encoding: 'utf8' },
      );
      assert.notEqual(result.status, 0);
    }
    await writeFile(metadataFile, metadata);
    const valid = spawnSync(
      process.execPath,
      ['scripts/build-browser-rpc-userscript.mjs', entry, metadataFile, output],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(valid.status, 0, valid.stderr);
  } finally {
    await rm(directory, { recursive: true });
  }
});
