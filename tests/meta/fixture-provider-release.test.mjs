import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const releaseWorkflow = await readFile(
  new URL('../../.github/workflows/release.yml', import.meta.url),
  'utf8',
);
const providerManifest = JSON.parse(
  await readFile(new URL('../../extensions/fixture-provider/package.json', import.meta.url)),
);
const providerLicense = await readFile(
  new URL('../../extensions/fixture-provider/LICENSE', import.meta.url),
  'utf8',
);

test('fixture provider release identity is repository-owned and licensed', () => {
  assert.equal(providerManifest.publisher, 'hrashton');
  assert.equal(providerManifest.private, true);
  assert.equal(providerManifest.repository?.url, 'https://github.com/HRAshton/remotish.git');
  assert.match(providerLicense, /^Zero-Clause BSD$/mu);
});

test('release workflow publishes the fixture provider VSIX with release controls', () => {
  assert.match(releaseWorkflow, /fixture_provider_version=/u);
  assert.match(releaseWorkflow, /extensions\/fixture-provider\/package\.json/u);
  assert.match(releaseWorkflow, /test "\$fixture_provider_version" = "\$version"/u);
  assert.match(releaseWorkflow, /sha256sum[\s\S]*remotish-fixture-provider\.vsix/u);
  assert.match(releaseWorkflow, /remotish-fixture-provider\.vsix[\s\S]*> SHA256SUMS/u);
  assert.match(
    releaseWorkflow,
    /Attest build provenance[\s\S]*artifacts\/remotish-fixture-provider\.vsix/u,
  );
  assert.match(
    releaseWorkflow,
    /gh release create[\s\S]*artifacts\/remotish-fixture-provider\.vsix/u,
  );
});
