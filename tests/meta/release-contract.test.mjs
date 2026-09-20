import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

const rootManifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
const packagePaths = [
  '../../packages/adapter-sdk/package.json',
  '../../packages/adapter-fixture/package.json',
  '../../packages/core/package.json',
  '../../packages/vscode/package.json',
  '../../packages/vscode-history/package.json',
  '../../adapters/github/package.json',
  '../../adapters/http-example/package.json',
  '../../apps/demo-web/package.json',
];

async function exists(url) {
  try {
    await access(url, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

test('repository supports the Node 22 and 24 LTS lines', () => {
  assert.equal(rootManifest.engines?.node, '>=22 <23 || >=24 <25');
});

test('VS Code web workspace URIs include an explicit root path', () => {
  for (const scriptName of ['vscode:web', 'test:vscode-web', 'test:vscode-web:vsix']) {
    assert.match(
      rootManifest.scripts?.[scriptName] ?? '',
      /--folder-uri=remotish:\/\/fixture-demo\//u,
      `${scriptName} must open a workspace URI with a non-empty path`,
    );
  }
});

test('packaged VSIX smoke includes a separately packaged web provider', async () => {
  const providerManifest = JSON.parse(
    await readFile(new URL('../fixtures/provider-extension/package.json', import.meta.url)),
  );
  assert.equal(providerManifest.browser, './dist/extension.js');
  assert.equal(providerManifest.main, undefined);
  assert.equal(providerManifest.extensionKind, undefined);
  assert.deepEqual(providerManifest.remotish, {
    provider: true,
    apiVersion: 1,
    id: 'fixture-provider',
    displayName: 'Fixture Provider',
  });

  assert.match(rootManifest.scripts?.['release:test-provider:vsix'] ?? '', /provider-vsix-smoke/u);
  assert.match(rootManifest.scripts?.['test:vscode-web:vsix'] ?? '', /release:test-provider:vsix/u);
  assert.match(
    rootManifest.scripts?.['test:vscode-web:vsix'] ?? '',
    /--extensionPath=artifacts\/vsix-smoke\/providers/u,
  );
});

test('releaseable workspace packages share the root release version', async () => {
  assert.match(rootManifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);

  for (const path of packagePaths) {
    const manifest = JSON.parse(await readFile(new URL(path, import.meta.url)));
    assert.equal(manifest.version, rootManifest.version, `${path} has a different release version`);
  }
});

test('VS Code proposal typings use the official update tool and stay aligned with the host', async () => {
  const vscodeVersion = rootManifest.devDependencies?.['@types/vscode'];
  const extensionManifest = JSON.parse(
    await readFile(new URL('../../apps/demo-web/package.json', import.meta.url)),
  );
  const proposals = ['scmActionButton', 'scmHistoryProvider', 'timeline'];

  assert.equal(vscodeVersion, '1.138.0');
  assert.equal(rootManifest.devDependencies?.['@vscode/dts'], '0.4.1');
  assert.equal(rootManifest.scripts?.['vscode:types'], undefined);
  assert.equal(
    rootManifest.scripts?.['vscode:types:update'],
    'pnpm --dir apps/demo-web exec dts dev 1.138.0 && shx rm -f "types/vscode-proposed/vscode.proposed.*.d.ts" && shx mv "apps/demo-web/vscode.proposed.*.d.ts" types/vscode-proposed/',
  );
  assert.equal(rootManifest.scripts?.postinstall, undefined);
  assert.equal(extensionManifest.engines?.vscode, `^${vscodeVersion}`);
  assert.deepEqual(extensionManifest.enabledApiProposals, proposals);

  for (const name of proposals) {
    assert.equal(
      await exists(
        new URL(`../../types/vscode-proposed/vscode.proposed.${name}.d.ts`, import.meta.url),
      ),
      true,
    );
  }
  assert.deepEqual(
    (await readdir(new URL('../../types/vscode-proposed/', import.meta.url)))
      .filter((name) => name.startsWith('vscode.proposed.') && name.endsWith('.d.ts'))
      .sort(),
    proposals.map((name) => `vscode.proposed.${name}.d.ts`).sort(),
  );

  assert.equal(
    await exists(new URL('../../scripts/check-vscode-types.mjs', import.meta.url)),
    false,
  );
  assert.equal(
    await exists(new URL('../../scripts/sync-vscode-types.mjs', import.meta.url)),
    false,
  );

  const gitignore = await readFile(new URL('../../.gitignore', import.meta.url), 'utf8');
  assert.doesNotMatch(gitignore, /^\.vscode-types\/$/mu);
});

test('build and release tools are exact direct dependencies without ephemeral execution', async () => {
  const expectedTools = {
    '@vscode/dts': '0.4.1',
    '@vscode/test-web': '0.0.80',
    '@vscode/vsce': '4.0.0',
    'dependency-cruiser': '18.3.1',
    esbuild: '0.28.2',
    knip: '6.36.0',
    'remark-cli': '12.0.1',
    'remark-validate-links': '13.1.0',
    typedoc: '0.28.20',
  };

  for (const [name, version] of Object.entries(expectedTools)) {
    assert.equal(rootManifest.devDependencies?.[name], version, `${name} must be pinned exactly`);
  }

  const workflowSources = await Promise.all([
    readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
    readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ]);
  const executableSurfaces = [...Object.values(rootManifest.scripts ?? {}), ...workflowSources];
  for (const source of executableSurfaces) {
    assert.doesNotMatch(source, /\bpnpm\s+d[l]x\b/u);
    assert.doesNotMatch(source, /\bp[n]px\b/u);
    assert.doesNotMatch(source, /\bn[p]x\b/u);
    assert.doesNotMatch(source, /\bnpm\s+ex[e]c\b/u);
  }

  for (const obsolete of [
    'run-locked-tool.mjs',
    'run-esbuild.mjs',
    'locked-tools.json',
    'check-locked-tooling.mjs',
    'check-markdown-links.mjs',
    'third-party-notices.mjs',
  ]) {
    assert.equal(await exists(new URL(`../../scripts/${obsolete}`, import.meta.url)), false);
  }
});

test('production dependencies stay internal and notices are tracked', async () => {
  const manifests = await Promise.all(
    packagePaths.map(async (path) => ({
      path,
      manifest: JSON.parse(await readFile(new URL(path, import.meta.url))),
    })),
  );
  const workspaceNames = new Set(manifests.map(({ manifest }) => manifest.name));

  for (const { path, manifest } of manifests) {
    for (const [name, specifier] of Object.entries(manifest.dependencies ?? {})) {
      assert.equal(
        name.startsWith('@remotish/'),
        true,
        `${path}: ${name} is an external runtime dependency`,
      );
      assert.equal(
        typeof specifier === 'string' && specifier.startsWith('workspace:'),
        true,
        `${path}: ${name} must use a workspace: specifier`,
      );
      assert.equal(
        workspaceNames.has(name),
        true,
        `${path}: ${name} is not a known workspace package`,
      );
    }
  }

  const notices = await readFile(new URL('../../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  assert.match(notices, /no third-party production npm dependencies/u);
});

test('adapter SDK is configured as the only public npm package', async () => {
  const sdkManifest = JSON.parse(
    await readFile(new URL('../../packages/adapter-sdk/package.json', import.meta.url)),
  );
  const vscodeManifest = JSON.parse(
    await readFile(new URL('../../packages/vscode/package.json', import.meta.url)),
  );
  assert.equal(sdkManifest.name, '@remotish/adapter-sdk');
  assert.equal(sdkManifest.private, undefined);
  assert.equal(sdkManifest.publishConfig?.access, 'public');
  assert.deepEqual(sdkManifest.files, ['dist']);
  assert.equal(vscodeManifest.publishConfig, undefined);
  assert.equal(vscodeManifest.exports?.['./provider-api'], undefined);

  const releaseWorkflow = await readFile(
    new URL('../../.github/workflows/release.yml', import.meta.url),
    'utf8',
  );
  assert.match(releaseWorkflow, /npm-publish:/u);
  assert.match(releaseWorkflow, /environment: npm/u);
  assert.match(releaseWorkflow, /id-token: write/u);
  assert.match(releaseWorkflow, /pnpm --filter @remotish\/adapter-sdk build/u);
  assert.doesNotMatch(releaseWorkflow, /packages\/vscode.*npm publish/u);
  assert.match(releaseWorkflow, /npm pack --dry-run/u);
  assert.match(releaseWorkflow, /publish_args=\(--access public\)/u);
  assert.match(releaseWorkflow, /publish_args\+=\(--tag beta\)/u);
  assert.match(releaseWorkflow, /npm publish/u);
  assert.doesNotMatch(releaseWorkflow, /NPM_TOKEN/u);
});

test('pnpm owns release versioning and CI uses the pinned package manager', async () => {
  assert.equal(rootManifest.packageManager, 'pnpm@12.5.1');
  assert.equal(
    rootManifest.scripts?.['release:version'],
    'pnpm version --recursive --no-git-tag-version',
  );
  assert.equal(await exists(new URL('../../scripts/release-version.mjs', import.meta.url)), false);

  const workspaceConfig = await readFile(
    new URL('../../pnpm-workspace.yaml', import.meta.url),
    'utf8',
  );
  assert.match(workspaceConfig, /^pmOnFail: ignore$/mu);
  assert.match(workspaceConfig, /^includeWorkspaceRoot: true$/mu);

  for (const workflow of ['ci.yml', 'release.yml']) {
    const source = await readFile(
      new URL(`../../.github/workflows/${workflow}`, import.meta.url),
      'utf8',
    );
    assert.match(source, /version: 12\.5\.1/u);
    assert.match(source, /pnpm run ci/u);
    assert.doesNotMatch(source, /(?:^|\s)pnpm ci(?:\s|$)/mu);
  }
});

test('release scripts delegate generic infrastructure to standard tooling', async () => {
  assert.equal(
    rootManifest.scripts?.clean,
    'tsc -b --clean && shx rm -rf artifacts apps/demo-web/dist',
  );
  assert.equal(await exists(new URL('../../scripts/clean.mjs', import.meta.url)), false);

  assert.equal(
    rootManifest.scripts?.['release:source'],
    'shx mkdir -p artifacts && git archive --format=tar.gz --output=artifacts/remotish-framework.tar.gz HEAD',
  );
  assert.equal(rootManifest.scripts?.sbom, undefined);
  assert.match(
    rootManifest.scripts?.ci ?? '',
    /pnpm sbom --sbom-format cyclonedx --sbom-spec-version 1\.6 --sbom-type application --prod --lockfile-only --out artifacts\/remotish\.cdx\.json/u,
  );
  assert.equal(await exists(new URL('../../scripts/generate-sbom.mjs', import.meta.url)), false);

  assert.equal(rootManifest.scripts?.['release:inspect-vsix'], undefined);
  assert.equal(await exists(new URL('../../scripts/inspect-vsix.mjs', import.meta.url)), false);
  assert.equal(await exists(new URL('../../scripts/vsix-archive.mjs', import.meta.url)), false);
  assert.equal(await exists(new URL('./vsix-archive.test.mjs', import.meta.url)), false);

  const vscodeIgnore = await readFile(
    new URL('../../apps/demo-web/.vscodeignore', import.meta.url),
    'utf8',
  );
  for (const rule of [
    '**/*.ts',
    '**/*.tsbuildinfo',
    'dist/test/**',
    'build/**',
    'src/**',
    'tsconfig.json',
  ]) {
    assert.match(
      vscodeIgnore,
      new RegExp(`^${rule.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'mu'),
    );
  }

  assert.equal(rootManifest.scripts?.['release:notices'], undefined);
  assert.equal(await exists(new URL('../../.node-version', import.meta.url)), false);
  assert.equal(await exists(new URL('../../.nvmrc', import.meta.url)), true);
});
