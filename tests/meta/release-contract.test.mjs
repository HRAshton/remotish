import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

const rootManifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const packagePaths = [
  '../../packages/adapter-sdk/package.json',
  '../../packages/adapter-fixture/package.json',
  '../../packages/core/package.json',
  '../../packages/vscode/package.json',
  '../../packages/vscode-history/package.json',
  '../../adapters/github/package.json',
  '../../adapters/git-http/package.json',
  '../../adapters/http-example/package.json',
  '../../adapters/rpc/package.json',
  '../../apps/demo-web/package.json',
  '../../extensions/fixture-provider/package.json',
  '../../extensions/browser-rpc-provider/package.json',
  '../../extensions/github-provider/package.json',
  '../../extensions/git-http-provider/package.json',
];

async function exists(url) {
  try {
    await access(url, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

test('repository supports the Node 22 and 24 LTS lines', () => {
  assert.equal(rootManifest.engines?.node, '>=22 <23 || >=24 <25');
});

test('VS Code web launchers load the host and fixture provider separately', () => {
  for (const scriptName of ['vscode:web', 'test:vscode-web']) {
    const script = rootManifest.scripts?.[scriptName] ?? '';
    assert.match(script, /--extensionDevelopmentPath=apps\/demo-web/u);
    assert.match(script, /--extensionPath=extensions\/fixture-provider/u);
    assert.doesNotMatch(script, /--folder-uri=remotish:\/\/fixture-demo\//u);
  }

  const packaged = rootManifest.scripts?.['test:vscode-web:vsix'] ?? '';
  assert.match(packaged, /--extensionDevelopmentPath=artifacts\/vsix-smoke\/extension/u);
  assert.match(packaged, /--extensionPath=artifacts\/vsix-smoke\/providers/u);
  assert.doesNotMatch(packaged, /--folder-uri=remotish:\/\/fixture-demo\//u);
});

test('packaged VSIX smoke uses the promoted fixture provider extension', async () => {
  const providerManifest = JSON.parse(
    await readFile(new URL('../../extensions/fixture-provider/package.json', import.meta.url)),
  );
  assert.equal(providerManifest.browser, './dist/extension.js');
  assert.equal(providerManifest.main, undefined);
  assert.deepEqual(providerManifest.activationEvents, ['onCommand:remotish.demo.openFixture']);
  assert.equal(providerManifest.extensionKind, undefined);
  assert.deepEqual(providerManifest.dependencies, {
    '@remotish/adapter-fixture': 'workspace:*',
    '@remotish/adapter-sdk': 'workspace:*',
  });
  assert.deepEqual(providerManifest.remotish, {
    provider: true,
    apiVersion: 1,
    id: 'fixture-provider',
    displayName: 'Fixture Provider',
  });

  assert.match(
    rootManifest.scripts?.['release:fixture-provider:vsix'] ?? '',
    /extensions\/fixture-provider/u,
  );
  assert.match(
    rootManifest.scripts?.['test:vscode-web:vsix'] ?? '',
    /release:fixture-provider:vsix/u,
  );
  assert.equal(
    await exists(new URL('../fixtures/provider-extension/package.json', import.meta.url)),
    false,
  );
  assert.equal(
    await exists(new URL('../../scripts/package-provider-vsix-smoke.mjs', import.meta.url)),
    false,
  );
});

test('releaseable workspace packages share the root release version', async () => {
  assert.match(rootManifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);

  for (const path of packagePaths) {
    const manifest = JSON.parse(await readFile(new URL(path, import.meta.url)));
    assert.equal(manifest.version, rootManifest.version, `${path} has a different release version`);
  }
});

test('VS Code host contract keeps version, engines, types, proposals, and Web smoke aligned', async () => {
  const hostVersion = rootManifest.codeOss?.version;
  const hostCommit = rootManifest.codeOss?.commit;
  const declarationBlobs = rootManifest.codeOss?.declarationBlobs ?? {};
  const typeManifest = JSON.parse(
    await readFile(new URL('../../types/vscode/package.json', import.meta.url)),
  );
  const extensionManifestPaths = [
    '../../apps/demo-web/package.json',
    '../../extensions/fixture-provider/package.json',
    '../../extensions/browser-rpc-provider/package.json',
    '../../extensions/github-provider/package.json',
    '../../extensions/git-http-provider/package.json',
  ];
  const extensionManifests = await Promise.all(
    extensionManifestPaths.map(async (path) => ({
      path,
      manifest: JSON.parse(await readFile(new URL(path, import.meta.url))),
    })),
  );
  const stableSmokeManifest = JSON.parse(
    await readFile(new URL('../../apps/demo-web/src/test/stable/package.json', import.meta.url)),
  );
  const proposals = ['scmHistoryProvider', 'timeline'];

  assert.match(hostVersion ?? '', exactVersion);
  assert.match(hostCommit ?? '', /^[0-9a-f]{40}$/u);
  assert.equal(rootManifest.devDependencies?.['@types/vscode'], 'link:types/vscode');
  assert.equal(typeManifest.name, '@types/vscode');
  assert.equal(typeManifest.version, hostVersion);
  assert.equal(typeManifest.types, 'index.d.ts');
  assert.equal(typeManifest.private, true);
  assert.equal(
    rootManifest.scripts?.['vscode:types:update'],
    `pnpm --dir apps/demo-web exec dts ${hostVersion} && shx mkdir -p types/vscode && shx mv "apps/demo-web/vscode.d.ts" types/vscode/index.d.ts && pnpm --dir apps/demo-web exec dts dev ${hostVersion} && shx rm -f "types/vscode-proposed/vscode.proposed.*.d.ts" && shx mv "apps/demo-web/vscode.proposed.*.d.ts" types/vscode-proposed/`,
  );
  assert.equal(rootManifest.scripts?.postinstall, undefined);

  for (const { path, manifest } of extensionManifests) {
    assert.equal(
      manifest.engines?.vscode,
      `^${hostVersion}`,
      `${path} has a different host engine`,
    );
  }
  assert.equal(extensionManifests[0].manifest.enabledApiProposals, undefined);
  assert.equal(stableSmokeManifest.engines?.vscode, `^${hostVersion}`);
  assert.equal(stableSmokeManifest.enabledApiProposals, undefined);

  function gitBlobSha(source) {
    const bytes = Buffer.from(source);
    return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  }

  const declarationPaths = {
    vscode: '../../types/vscode/index.d.ts',
    scmHistoryProvider: '../../types/vscode-proposed/vscode.proposed.scmHistoryProvider.d.ts',
    timeline: '../../types/vscode-proposed/vscode.proposed.timeline.d.ts',
  };
  assert.deepEqual(Object.keys(declarationBlobs).sort(), Object.keys(declarationPaths).sort());
  for (const [name, path] of Object.entries(declarationPaths)) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.equal(
      gitBlobSha(source),
      declarationBlobs[name],
      `${path} does not match the declared Code-OSS host declaration blob`,
    );
  }

  assert.deepEqual(
    (await readdir(new URL('../../types/vscode-proposed/', import.meta.url)))
      .filter((name) => name.startsWith('vscode.proposed.') && name.endsWith('.d.ts'))
      .sort(),
    proposals.map((name) => `vscode.proposed.${name}.d.ts`).sort(),
  );

  for (const scriptName of [
    'vscode:web',
    'test:vscode-web:stable',
    'test:vscode-web',
    'test:vscode-web:vsix',
  ]) {
    const script = rootManifest.scripts?.[scriptName] ?? '';
    const launches = script.split('vscode-test-web').length - 1;
    const pins = script.split(`vscode-test-web --quality=stable --commit=${hostCommit}`).length - 1;
    assert.ok(launches > 0, `${scriptName} does not launch Code-OSS Web`);
    assert.equal(
      pins,
      launches,
      `${scriptName} must pin every Code-OSS Web launch to the declared host commit`,
    );
  }

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

test('repository build tools are exact direct dependencies without ephemeral execution', async () => {
  const expectedTools = [
    '@vscode/dts',
    '@vscode/test-web',
    '@vscode/vsce',
    'dependency-cruiser',
    'esbuild',
    'knip',
    'remark-cli',
    'remark-validate-links',
    'typedoc',
  ];

  for (const name of expectedTools) {
    assert.match(
      rootManifest.devDependencies?.[name] ?? '',
      exactVersion,
      `${name} must be pinned exactly`,
    );
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

test('production dependencies are reviewed and notices are tracked', async () => {
  const manifests = await Promise.all(
    packagePaths.map(async (path) => ({
      path,
      manifest: JSON.parse(await readFile(new URL(path, import.meta.url))),
    })),
  );
  const workspaceNames = new Set(manifests.map(({ manifest }) => manifest.name));
  const gitHttpDependencies = new Set(['@isomorphic-git/lightning-fs', 'isomorphic-git', 'memfs']);
  const reviewedVersions = new Map();

  for (const { path, manifest } of manifests) {
    for (const [name, specifier] of Object.entries(manifest.dependencies ?? {})) {
      if (
        (path === '../../adapters/git-http/package.json' ||
          path === '../../extensions/git-http-provider/package.json') &&
        gitHttpDependencies.has(name)
      ) {
        assert.match(specifier, exactVersion, `${path}: ${name} must be pinned exactly`);
        if (reviewedVersions.has(name)) {
          assert.equal(specifier, reviewedVersions.get(name), `${name} versions must agree`);
        }
        reviewedVersions.set(name, specifier);
        continue;
      }
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

  assert.equal(reviewedVersions.size, gitHttpDependencies.size);
  const notices = await readFile(new URL('../../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  for (const [name, version] of reviewedVersions) {
    assert.match(
      notices,
      new RegExp(`^\\| ${escapeRegExp(name)} \\| ${escapeRegExp(version)} \\|`, 'mu'),
    );
  }
  assert.match(
    rootManifest.scripts?.['release:git-http-provider:vsix'] ?? '',
    /shx cp THIRD_PARTY_NOTICES\.md extensions\/git-http-provider\/dist\/THIRD_PARTY_NOTICES\.md/u,
  );
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
  const pnpmVersion = rootManifest.packageManager?.match(/^pnpm@(\d+\.\d+\.\d+)$/u)?.[1];
  assert.ok(pnpmVersion, 'pnpm must be pinned to an exact version');
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
    assert.match(source, new RegExp(`^\\s+version: ${escapeRegExp(pnpmVersion)}$`, 'mu'));
    assert.match(source, /pnpm run ci/u);
    assert.doesNotMatch(source, /(?:^|\s)pnpm ci(?:\s|$)/mu);
  }
});

test('CI push checks target the repository default branch', async () => {
  const ciWorkflow = await readFile(
    new URL('../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  assert.match(ciWorkflow, /^ {2}push:\r?\n {4}branches:\r?\n {6}- master$/mu);
  assert.match(ciWorkflow, /pnpm test:vscode-web:stable/u);
});

test('release scripts delegate generic infrastructure to standard tooling', async () => {
  assert.equal(
    rootManifest.scripts?.clean,
    'tsc -b --clean && shx rm -rf artifacts apps/demo-web/dist extensions/fixture-provider/dist extensions/browser-rpc-provider/dist extensions/github-provider/dist extensions/git-http-provider/dist',
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
