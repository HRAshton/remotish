import * as vscode from 'vscode';

interface ActivatedGitHubProvider {
  validateRepository(repository: Readonly<Record<string, string>>): void;
  createAdapter(
    repository: Readonly<Record<string, string>>,
  ): { readonly capabilities: { readonly commits: boolean } } | Promise<{
    readonly capabilities: { readonly commits: boolean };
  }>;
}

/** Verify discovery, lazy activation, descriptor strictness, and anonymous capabilities. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('hrashton.remotish-github-provider');
  if (!extension) {
    throw new Error('GitHub provider was not loaded into Code-OSS Web.');
  }
  const manifest = extension.packageJSON as Record<string, unknown>;
  const marker = manifest.remotish as Record<string, unknown> | undefined;
  if (marker?.provider !== true || marker.apiVersion !== 1 || marker.id !== 'github') {
    throw new Error('GitHub provider discovery marker is invalid.');
  }
  if (manifest.browser !== './dist/extension.js') {
    throw new Error('GitHub provider Web entry point is missing.');
  }
  if (extension.isActive) {
    throw new Error('GitHub provider activated during manifest discovery.');
  }

  const provider = (await extension.activate()) as ActivatedGitHubProvider;
  const repository = { owner: 'octocat', repository: 'Hello-World' };
  provider.validateRepository(repository);
  try {
    provider.validateRepository({ ...repository, token: 'secret' });
  } catch {
    const adapter = await provider.createAdapter(repository);
    if (adapter.capabilities.commits !== false) {
      throw new Error('Anonymous GitHub provider unexpectedly enabled remote commits.');
    }
    return;
  }
  throw new Error('GitHub provider accepted a credential in the descriptor.');
}
