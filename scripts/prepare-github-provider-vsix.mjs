import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const sourceManifestUrl = new URL('extensions/github-provider/package.json', root);
const stageUrl = new URL('artifacts/github-provider-vsix/', root);

export function createGitHubProviderReleaseManifest(sourceManifest) {
  if (
    sourceManifest.name !== 'remotish-github-provider' ||
    sourceManifest.publisher !== 'hrashton'
  ) {
    throw new Error('Unexpected Remotish GitHub provider extension identity.');
  }

  const manifest = structuredClone(sourceManifest);
  manifest.extensionDependencies = ['hrashton.remotish'];
  return manifest;
}

async function prepare() {
  const sourceManifest = JSON.parse(await readFile(sourceManifestUrl, 'utf8'));
  const manifest = createGitHubProviderReleaseManifest(sourceManifest);

  await rm(stageUrl, { recursive: true, force: true });
  await mkdir(new URL('dist/', stageUrl), { recursive: true });
  await writeFile(new URL('package.json', stageUrl), `${JSON.stringify(manifest, null, 2)}\n`);
  await copyFile(
    new URL('extensions/github-provider/README.md', root),
    new URL('README.md', stageUrl),
  );
  await copyFile(new URL('extensions/github-provider/LICENSE', root), new URL('LICENSE', stageUrl));
  await copyFile(
    new URL('extensions/github-provider/dist/extension.js', root),
    new URL('dist/extension.js', stageUrl),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await prepare();
}
