import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const rootManifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
const releaseWorkflow = await readFile(
  new URL('../../.github/workflows/release.yml', import.meta.url),
  'utf8',
);
const prepareVsixSmoke = await readFile(
  new URL('../../scripts/prepare-vsix-smoke.mjs', import.meta.url),
  'utf8',
);

test('host VSIX uses the Remotish product artifact name everywhere release tooling consumes it', () => {
  const releaseVsix = rootManifest.scripts?.['release:vsix'] ?? '';
  const prepareVsix = rootManifest.scripts?.['prepare:vscode-web-vsix'] ?? '';

  assert.match(releaseVsix, /--out \.\.\/\.\.\/artifacts\/remotish\.vsix$/u);
  assert.equal(
    prepareVsix,
    'node scripts/prepare-vsix-smoke.mjs artifacts/remotish.vsix artifacts/remotish-fixture-provider.vsix artifacts/remotish-browser-rpc-provider.vsix',
  );
  assert.match(prepareVsixSmoke, /process\.argv\[2\] \?\? 'artifacts\/remotish\.vsix'/u);

  assert.match(releaseWorkflow, /sha256sum[\s\S]*remotish\.vsix/u);
  assert.match(releaseWorkflow, /Attest build provenance[\s\S]*artifacts\/remotish\.vsix/u);
  assert.match(releaseWorkflow, /Attest SBOM[\s\S]*subject-path: artifacts\/remotish\.vsix/u);
  assert.match(releaseWorkflow, /gh release create[\s\S]*artifacts\/remotish\.vsix/u);
});
