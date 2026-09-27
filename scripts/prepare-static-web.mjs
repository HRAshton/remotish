import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const vscodeBuildDirectory = resolve(process.argv[2] ?? '');
const outputDirectory = resolve(process.argv[3] ?? 'artifacts/web-demo');

if (!process.argv[2]) {
  throw new Error(
    'Usage: node scripts/prepare-static-web.mjs <out-vscode-web-min> [output-directory]',
  );
}

async function requireFile(path) {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error(`Expected file: ${path}`);
  }
}

async function copyExtension(source, target) {
  await mkdir(target, { recursive: true });
  await cp(resolve(source, 'package.json'), resolve(target, 'package.json'));
  await cp(resolve(source, 'dist'), resolve(target, 'dist'), { recursive: true });
}

for (const relativePath of [
  'out/nls.messages.js',
  'out/vs/code/browser/workbench/workbench.js',
  'out/vs/code/browser/workbench/workbench.css',
]) {
  await requireFile(resolve(vscodeBuildDirectory, relativePath));
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(resolve(repositoryRoot, 'site'), outputDirectory, { recursive: true });
await cp(vscodeBuildDirectory, resolve(outputDirectory, 'workbench/static/build'), {
  recursive: true,
});

const extensionSources = [
  ['host', 'apps/demo-web'],
  ['fixture-provider', 'extensions/fixture-provider'],
  ['browser-rpc-provider', 'extensions/browser-rpc-provider'],
  ['git-http-provider', 'extensions/git-http-provider'],
];

for (const [targetName, sourcePath] of extensionSources) {
  await copyExtension(
    resolve(repositoryRoot, sourcePath),
    resolve(outputDirectory, 'extensions', targetName),
  );
}

await cp(resolve(repositoryRoot, 'LICENSE'), resolve(outputDirectory, 'LICENSE'));
await cp(
  resolve(repositoryRoot, 'THIRD_PARTY_NOTICES.md'),
  resolve(outputDirectory, 'THIRD_PARTY_NOTICES.md'),
);

const workbenchHtml = `<!doctype html>
<html lang="en">
  <head>
    <script>performance.mark('code/didStartRenderer');</script>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no" />
    <meta id="vscode-workbench-web-configuration" data-settings="{}" />
    <title>Remotish Web Demo</title>
  </head>
  <body aria-label=""></body>
  <script type="module">
    const buildBase = new URL('./static/build/', window.location.href);
    globalThis._VSCODE_FILE_ROOT = new URL('./out/', buildBase).href;

    const asUriComponents = (url) => ({
      scheme: url.protocol.slice(0, -1),
      authority: url.host,
      path: url.pathname.replace(/\\/$/u, ''),
    });

    const extensionEnabledApiProposals = {
      'hrashton.remotish': ['scmActionButton', 'scmHistoryProvider', 'timeline'],
    };

    const extensionPaths = [
      '../extensions/host/',
      '../extensions/fixture-provider/',
      '../extensions/browser-rpc-provider/',
      '../extensions/git-http-provider/',
    ];

    const config = {
      workspaceUri: { scheme: 'tmp', path: '/default.code-workspace' },
      callbackRoute: window.location.pathname,
      additionalBuiltinExtensions: extensionPaths.map((path) =>
        asUriComponents(new URL(path, window.location.href)),
      ),
      productConfiguration: {
        enableTelemetry: false,
        extensionEnabledApiProposals,
      },
    };

    document
      .querySelector('#vscode-workbench-web-configuration')
      .setAttribute('data-settings', JSON.stringify(config));

    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('./out/vs/code/browser/workbench/workbench.css', buildBase).href;
    document.head.append(stylesheet);

    performance.mark('code/willLoadWorkbenchMain');
    await import(new URL('./out/nls.messages.js', buildBase).href);
    await import(new URL('./out/vs/code/browser/workbench/workbench.js', buildBase).href);
  </script>
</html>
`;

await mkdir(resolve(outputDirectory, 'workbench'), { recursive: true });
await writeFile(resolve(outputDirectory, 'workbench/index.html'), workbenchHtml);
await writeFile(resolve(outputDirectory, '.nojekyll'), '');

const registry = JSON.parse(await readFile(resolve(outputDirectory, 'examples.json'), 'utf8'));
if (!Array.isArray(registry.examples) || registry.examples.length === 0) {
  throw new Error('site/examples.json must contain at least one example');
}

console.log(`Prepared static web demo in ${outputDirectory}`);
