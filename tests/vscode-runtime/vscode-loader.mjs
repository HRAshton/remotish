const vscodeStubUrl = new URL('./vscode-stub/index.js', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'vscode') {
    return { url: vscodeStubUrl, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}
