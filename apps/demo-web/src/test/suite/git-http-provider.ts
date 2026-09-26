import * as vscode from 'vscode';

/** Verify provider discovery and Web activation from source or an unpacked pilot VSIX. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('hrashton.remotish-git-http-provider');
  if (!extension) {
    throw new Error('Git HTTP provider was not loaded into Code-OSS Web.');
  }
  const manifest = extension.packageJSON as Record<string, unknown>;
  const marker = manifest.remotish as Record<string, unknown> | undefined;
  if (marker?.provider !== true || marker.apiVersion !== 1 || marker.id !== 'git-http') {
    throw new Error('Git HTTP provider discovery marker is invalid.');
  }
  if (manifest.browser !== './dist/extension.js') {
    throw new Error('Git HTTP provider Web entry point is missing.');
  }
  if (extension.isActive) {
    throw new Error('Git HTTP provider activated during manifest discovery.');
  }
  const provider: unknown = await extension.activate();
  if (!provider || typeof provider !== 'object' || !('validateRepository' in provider)) {
    throw new Error('Git HTTP provider did not activate its API.');
  }
  const validate = provider.validateRepository;
  if (typeof validate !== 'function') {
    throw new Error('Git HTTP provider descriptor validator is missing.');
  }
  validate({ url: 'https://git.example.invalid/scm/PRJ/repo.git' });
  try {
    validate({ url: 'https://git.example.invalid/scm/PRJ/repo.git', token: 'secret' });
  } catch {
    return;
  }
  throw new Error('Git HTTP provider accepted a credential in the descriptor.');
}
