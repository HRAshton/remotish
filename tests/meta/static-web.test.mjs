import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const rootManifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
const registry = JSON.parse(await readFile(new URL('../../site/examples.json', import.meta.url)));
const workflow = await readFile(
  new URL('../../.github/workflows/pages.yml', import.meta.url),
  'utf8',
);
const ciWorkflow = await readFile(
  new URL('../../.github/workflows/ci.yml', import.meta.url),
  'utf8',
);
const assembler = await readFile(
  new URL('../../scripts/prepare-static-web.mjs', import.meta.url),
  'utf8',
);

test('static web registry is explicit about live, setup and source-only examples', () => {
  assert.equal(registry.schemaVersion, 1);
  assert.ok(Array.isArray(registry.examples));
  assert.ok(registry.examples.length >= 4);

  const ids = new Set();
  const allowedKinds = new Set(['live', 'setup', 'source']);
  const browserProviders = new Set(['fixture-provider', 'browser-rpc', 'git-http']);

  for (const example of registry.examples) {
    assert.match(example.id, /^[a-z0-9-]+$/u);
    assert.equal(ids.has(example.id), false, `duplicate example id: ${example.id}`);
    ids.add(example.id);
    assert.equal(allowedKinds.has(example.kind), true, `${example.id}: unsupported kind`);
    assert.match(example.docs, /^https:\/\/github\.com\/HRAshton\/remotish\//u);

    if (example.kind === 'source') {
      assert.equal(example.launch, undefined);
      assert.equal(example.provider, undefined);
    } else {
      assert.equal(browserProviders.has(example.provider), true, `${example.id}: unknown provider`);
      assert.equal(example.launch, 'workbench/');
      assert.equal(typeof example.command, 'string');
    }

    const serialized = JSON.stringify(example);
    assert.doesNotMatch(serialized, /clientSecret|accessToken|privateKey|password/iu);
  }

  const gitHttp = registry.examples.find((example) => example.id === 'git-http');
  assert.equal(gitHttp?.kind, 'setup');
  assert.match(gitHttp.summary, /pairing key.*userscript.*bearer token/u);
});

test('static web deployment stays aligned with the pinned VS Code and pnpm versions', () => {
  const vscodeVersion = rootManifest.devDependencies?.['@types/vscode'];
  const pnpmVersion = rootManifest.packageManager?.replace(/^pnpm@/u, '');

  assert.match(vscodeVersion ?? '', /^\d+\.\d+\.\d+$/u);
  assert.match(pnpmVersion ?? '', /^\d+\.\d+\.\d+$/u);
  assert.match(workflow, new RegExp(`^  VSCODE_VERSION: ${vscodeVersion}$`, 'mu'));
  assert.match(workflow, new RegExp(`^          version: ${pnpmVersion}$`, 'mu'));
  assert.match(workflow, /--target server-web --out out-vscode-reh-web-min/u);
  assert.match(workflow, /node build\/next\/index\.ts bundle --minify --nls/u);
  assert.match(workflow, /pnpm bundle:web-static:extensions/u);
  for (const config of [workflow, ciWorkflow]) {
    assert.match(config, /npm run gulp copy-codicons compile-web-extensions-build/u);
    assert.match(config, /cp -a \.build\/web\/extensions\/\. \.build\/extensions\//u);
    assert.match(config, /VSCODE_WEB_BUILD: \.vscode-web-source/u);
  }
  assert.match(workflow, /pnpm prepare:web-static \.vscode-web-source artifacts\/web-demo/u);
  assert.match(ciWorkflow, / {2}pull_request:/u);
  assert.match(ciWorkflow, / {2}static-web:/u);
  assert.match(ciWorkflow, new RegExp(`^  VSCODE_VERSION: ${vscodeVersion}$`, 'mu'));
  assert.match(ciWorkflow, /ref: \$\{\{ env\.VSCODE_VERSION \}\}/u);
  assert.match(
    ciWorkflow,
    /node build\/next\/index\.ts bundle --minify --nls --target server-web/u,
  );
  assert.match(workflow, /actions\/upload-pages-artifact@[0-9a-f]{40}/u);
  assert.match(workflow, /actions\/deploy-pages@[0-9a-f]{40}/u);
});

test('static workbench uses relative assets and bundles only browser extension outputs', () => {
  for (const extensionPath of [
    'apps/demo-web',
    'extensions/fixture-provider',
    'extensions/browser-rpc-provider',
    'extensions/git-http-provider',
  ]) {
    assert.equal(assembler.includes(extensionPath), true, `${extensionPath} is not copied`);
  }

  assert.match(assembler, /workbench\/workbench\.js/u);
  assert.match(assembler, /additionalBuiltinExtensions/u);
  assert.match(assembler, /extensionEnabledApiProposals/u);
  assert.doesNotMatch(assembler, /https?:\/\/(?:localhost|127\.0\.0\.1)/u);
});

test('static assembler packages Code-OSS output and built-in extensions', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'remotish-static-web-'));
  const sourceRoot = join(temporaryRoot, 'vscode-source');
  const rawBuild = join(sourceRoot, 'out-vscode-reh-web-min');
  const output = join(temporaryRoot, 'web-demo');

  try {
    await mkdir(join(temporaryRoot, 'scripts'), { recursive: true });
    await cp(
      new URL('../../scripts/prepare-static-web.mjs', import.meta.url),
      join(temporaryRoot, 'scripts/prepare-static-web.mjs'),
    );
    await cp(new URL('../../site/', import.meta.url), join(temporaryRoot, 'site'), {
      recursive: true,
    });
    for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
      await cp(new URL(`../../${name}`, import.meta.url), join(temporaryRoot, name));
    }

    for (const source of [
      'apps/demo-web',
      'extensions/fixture-provider',
      'extensions/browser-rpc-provider',
      'extensions/git-http-provider',
    ]) {
      const target = join(temporaryRoot, source);
      await mkdir(join(target, 'dist'), { recursive: true });
      await cp(
        new URL(`../../${source}/package.json`, import.meta.url),
        join(target, 'package.json'),
      );
      await writeFile(join(target, 'dist/extension.js'), '// bundled extension fixture\n');
    }

    for (const path of [
      'nls.messages.js',
      'vs/code/browser/workbench/workbench.js',
      'vs/code/browser/workbench/workbench.css',
      'vs/code/browser/workbench/callback.html',
    ]) {
      const target = join(rawBuild, path);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, `// ${path}\n`);
    }
    const builtInExtension = join(sourceRoot, '.build/web/extensions/git');
    await mkdir(builtInExtension, { recursive: true });
    await writeFile(join(builtInExtension, 'package.json'), '{}\n');

    const result = spawnSync(
      process.execPath,
      [join(temporaryRoot, 'scripts/prepare-static-web.mjs'), sourceRoot, output],
      {
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    for (const path of [
      'workbench/static/build/out/nls.messages.js',
      'workbench/static/build/out/vs/code/browser/workbench/workbench.js',
      'workbench/static/build/out/vs/code/browser/workbench/workbench.css',
      'workbench/static/build/out/vs/code/browser/workbench/callback.html',
      'workbench/static/build/extensions/git/package.json',
      'extensions/host/dist/extension.js',
      'workbench/index.html',
    ]) {
      assert.equal((await stat(join(output, path))).isFile(), true, path);
    }
    const workbench = await readFile(join(output, 'workbench/index.html'), 'utf8');
    assert.match(
      workbench,
      /callbackRoute: new URL\('\.\/static\/build\/out\/vs\/code\/browser\/workbench\/callback\.html'/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('static assembler accepts the pinned Code-OSS build output', {
  skip: !process.env.VSCODE_WEB_BUILD,
}, async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'remotish-vscode-build-'));
  const output = join(temporaryRoot, 'web-demo');
  try {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../../scripts/prepare-static-web.mjs', import.meta.url)),
        process.env.VSCODE_WEB_BUILD,
        output,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    for (const path of [
      'workbench/static/build/out/nls.messages.js',
      'workbench/static/build/out/vs/code/browser/workbench/workbench.js',
      'workbench/static/build/out/vs/code/browser/workbench/workbench.css',
      'workbench/static/build/out/vs/code/browser/workbench/callback.html',
      'workbench/index.html',
    ]) {
      assert.equal((await stat(join(output, path))).isFile(), true, path);
    }
    const builtInExtensions = await readdir(
      join(process.env.VSCODE_WEB_BUILD, '.build/web/extensions'),
    );
    assert.ok(builtInExtensions.length > 0, 'Code-OSS built-in extensions are missing');
    assert.equal(
      (
        await stat(join(output, 'workbench/static/build/extensions', builtInExtensions[0]))
      ).isDirectory(),
      true,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
