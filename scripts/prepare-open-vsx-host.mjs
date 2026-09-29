import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const sourceManifestUrl = new URL('apps/demo-web/package.json', root);
const stageUrl = new URL('artifacts/open-vsx-host/', root);

export function createOpenVsxHostManifest(sourceManifest) {
  if (sourceManifest.name !== 'remotish' || sourceManifest.publisher !== 'hrashton') {
    throw new Error('Unexpected Remotish host extension identity.');
  }

  const manifest = structuredClone(sourceManifest);
  delete manifest.enabledApiProposals;
  manifest.description =
    'Stable-API Remotish host extension with automatic adapter provider discovery.';
  manifest.dependencies = {
    '@remotish/vscode': 'workspace:*',
  };
  manifest.categories = ['SCM Providers', 'Other'];
  manifest.keywords = [
    'remote repositories',
    'virtual filesystem',
    'source control',
    'code oss',
    'open vsx',
  ];
  return manifest;
}

async function prepare() {
  const sourceManifest = JSON.parse(await readFile(sourceManifestUrl, 'utf8'));
  const manifest = createOpenVsxHostManifest(sourceManifest);

  await rm(stageUrl, { recursive: true, force: true });
  await mkdir(new URL('dist/', stageUrl), { recursive: true });
  await writeFile(new URL('package.json', stageUrl), `${JSON.stringify(manifest, null, 2)}\n`);
  await copyFile(
    new URL('apps/demo-web/README.open-vsx.md', root),
    new URL('README.md', stageUrl),
  );
  await copyFile(new URL('apps/demo-web/LICENSE', root), new URL('LICENSE', stageUrl));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await prepare();
}
