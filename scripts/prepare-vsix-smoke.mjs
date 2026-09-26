import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const vsixPath = resolve(process.argv[2] ?? 'artifacts/remotish.vsix');
const providerVsixPath = resolve(process.argv[3] ?? 'artifacts/remotish-fixture-provider.vsix');
const browserRpcVsixPath = resolve(
  process.argv[4] ?? 'artifacts/remotish-browser-rpc-provider.vsix',
);
const gitHttpVsixPath = resolve(process.argv[5] ?? 'artifacts/remotish-git-http-provider.vsix');
const smokeRoot = resolve('artifacts/vsix-smoke');
const extensionRoot = resolve(smokeRoot, 'extension');
const providerArchiveRoot = resolve(smokeRoot, 'provider-archive');
const providersRoot = resolve(smokeRoot, 'providers');
const providerRoot = resolve(providersRoot, 'remotish-fixture-provider');
const browserRpcArchiveRoot = resolve(smokeRoot, 'browser-rpc-archive');
const browserRpcRoot = resolve(providersRoot, 'remotish-browser-rpc-provider');
const gitHttpArchiveRoot = resolve(smokeRoot, 'git-http-archive');
const gitHttpRoot = resolve(providersRoot, 'remotish-git-http-provider');
const testBundle = resolve('apps/demo-web/dist/test/suite/vsix.js');
const packagedTestBundle = resolve(extensionRoot, 'dist/test/suite/vsix.js');
const bootstrapTestBundle = resolve('apps/demo-web/dist/test/suite/bootstrap.js');
const packagedBootstrapTestBundle = resolve(extensionRoot, 'dist/test/suite/bootstrap.js');

function extractVsix(archive, destination) {
  const windows = process.platform === 'win32';
  execFileSync(
    windows ? 'tar' : 'unzip',
    windows ? ['-xf', archive, '-C', destination] : ['-q', archive, '-d', destination],
    { stdio: 'inherit' },
  );
}

rmSync(smokeRoot, { recursive: true, force: true });
mkdirSync(smokeRoot, { recursive: true });
extractVsix(vsixPath, smokeRoot);
mkdirSync(dirname(packagedTestBundle), { recursive: true });
cpSync(testBundle, packagedTestBundle);
cpSync(bootstrapTestBundle, packagedBootstrapTestBundle);

mkdirSync(providerArchiveRoot, { recursive: true });
extractVsix(providerVsixPath, providerArchiveRoot);
mkdirSync(providersRoot, { recursive: true });
cpSync(resolve(providerArchiveRoot, 'extension'), providerRoot, { recursive: true });
rmSync(providerArchiveRoot, { recursive: true, force: true });

mkdirSync(browserRpcArchiveRoot, { recursive: true });
extractVsix(browserRpcVsixPath, browserRpcArchiveRoot);
cpSync(resolve(browserRpcArchiveRoot, 'extension'), browserRpcRoot, { recursive: true });
rmSync(browserRpcArchiveRoot, { recursive: true, force: true });

mkdirSync(gitHttpArchiveRoot, { recursive: true });
extractVsix(gitHttpVsixPath, gitHttpArchiveRoot);
cpSync(resolve(gitHttpArchiveRoot, 'extension'), gitHttpRoot, { recursive: true });
rmSync(gitHttpArchiveRoot, { recursive: true, force: true });

console.log(`Prepared packaged host extension at ${extensionRoot}.`);
console.log(`Prepared packaged provider extensions at ${providersRoot}.`);
