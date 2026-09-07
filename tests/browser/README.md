# Browser integration tests

The real Code-OSS Web smoke suite lives with the demo extension under `apps/demo-web/src/test/suite/` because it is bundled and executed as an extension test entry point.

Run it from the repository root:

```sh
corepack pnpm test:vscode-web
```

To test the exact packaged artifact instead of the source extension directory:

```sh
corepack pnpm test:vscode-web:vsix
```

See [`docs/code-oss-integration.md`](../../docs/code-oss-integration.md) for the verification model.
