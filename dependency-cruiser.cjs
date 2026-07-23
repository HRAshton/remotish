/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular-dependencies',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'adapter-sdk-is-foundational',
      severity: 'error',
      from: { path: '^packages/adapter-sdk/' },
      to: { path: '^(packages/(core|vscode|vscode-history)/|adapters/)' },
    },
    {
      name: 'adapters-only-use-sdk',
      severity: 'error',
      from: { path: '^adapters/' },
      to: { path: '^packages/(core|vscode|vscode-history)/' },
    },
    {
      name: 'core-does-not-depend-upwards',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: { path: '^(packages/(vscode|vscode-history)/|adapters/)' },
    },
    {
      name: 'vscode-does-not-depend-on-history-or-adapters',
      severity: 'error',
      from: { path: '^packages/vscode/' },
      to: { path: '^(packages/vscode-history/|adapters/)' },
    },
    {
      name: 'history-does-not-depend-on-adapters',
      severity: 'error',
      from: { path: '^packages/vscode-history/' },
      to: { path: '^adapters/' },
    },
    {
      name: 'vscode-api-only-in-vscode-layers',
      severity: 'error',
      from: { path: '^(packages/(adapter-sdk|core)/|adapters/)' },
      to: { path: '^vscode$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: '(^|/)dist/|(^|/)build/',
    tsPreCompilationDeps: true,
  },
};
