import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const sourceManifestUrl = new URL('apps/demo-web/package.json', root);
const stageUrl = new URL('artifacts/open-vsx-host/', root);

const manifest = JSON.parse(await readFile(sourceManifestUrl, 'utf8'));

if (manifest.name !== 'remotish' || manifest.publisher !== 'hrashton') {
  throw new Error('Unexpected Remotish host extension identity.');
}

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

await rm(stageUrl, { recursive: true, force: true });
await mkdir(new URL('dist/', stageUrl), { recursive: true });
await writeFile(new URL('package.json', stageUrl), `${JSON.stringify(manifest, null, 2)}\n`);
await copyFile(new URL('apps/demo-web/README.open-vsx.md', root), new URL('README.md', stageUrl));
await copyFile(new URL('apps/demo-web/LICENSE', root), new URL('LICENSE', stageUrl));
