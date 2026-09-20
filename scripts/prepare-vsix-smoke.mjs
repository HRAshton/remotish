import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const vsixPath = resolve(process.argv[2] ?? 'artifacts/remotish-demo.vsix');
const providerVsixPath = resolve(process.argv[3] ?? 'artifacts/remotish-fixture-provider.vsix');
const smokeRoot = resolve('artifacts/vsix-smoke');
const extensionRoot = resolve(smokeRoot, 'extension');
const providerArchiveRoot = resolve(smokeRoot, 'provider-archive');
const providersRoot = resolve(smokeRoot, 'providers');
const providerRoot = resolve(providersRoot, 'remotish-fixture-provider');
const testBundle = resolve('apps/demo-web/dist/test/suite/vsix.js');
const packagedTestBundle = resolve(extensionRoot, 'dist/test/suite/vsix.js');

rmSync(smokeRoot, { recursive: true, force: true });
mkdirSync(smokeRoot, { recursive: true });
execFileSync('unzip', ['-q', vsixPath, '-d', smokeRoot], { stdio: 'inherit' });
mkdirSync(dirname(packagedTestBundle), { recursive: true });
cpSync(testBundle, packagedTestBundle);

mkdirSync(providerArchiveRoot, { recursive: true });
execFileSync('unzip', ['-q', providerVsixPath, '-d', providerArchiveRoot], { stdio: 'inherit' });
mkdirSync(providersRoot, { recursive: true });
cpSync(resolve(providerArchiveRoot, 'extension'), providerRoot, { recursive: true });
rmSync(providerArchiveRoot, { recursive: true, force: true });

console.log(`Prepared packaged host extension at ${extensionRoot}.`);
console.log(`Prepared packaged provider extensions at ${providersRoot}.`);
