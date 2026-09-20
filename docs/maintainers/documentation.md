# Documentation maintenance

The documentation is intentionally split by audience so implementation details do not bury the adapter-author path.

## Canonical sources

Use one canonical page for each kind of information:

| Topic | Canonical location |
| --- | --- |
| Product pitch / entry links | `README.md` |
| First run / composition | `docs/getting-started.md` |
| State model / semantics overview | `docs/concepts.md` |
| Adapter tutorial | `docs/adapter-authoring.md` |
| Exact adapter semantics | `docs/adapter-contract.md` |
| Adapter verification | `docs/testing-adapters.md` |
| Provider extensions | `docs/provider-extensions.md` |
| VS Code composition | `docs/vscode-integration.md` |
| Package/runtime architecture | `docs/architecture.md` |
| Proposal/host details | `docs/code-oss-integration.md` |
| Release controls | `docs/release-security.md` |
| Package-specific usage | package `README.md` |

Other pages should link to the canonical explanation instead of copying it.

## Documentation rules

- Lead with the user's task or decision, not implementation history.
- Keep the root README short enough to scan before opening a guide.
- Use code examples that match exported package-root APIs.
- Mark proposal-dependent VS Code features explicitly.
- Do not document planned APIs as if they exist.
- Do not use prototype planning documents as current behavior.
- Update docs in the same change as public behavior or package-surface changes.
- Prefer relative repository links so docs work in branches and source archives.

## Before merging a documentation change

Run the built-in link check:

```bash
corepack pnpm lint:markdown
```

Then check that:

- links resolve;
- package/method names match exported APIs;
- commands exist in root `package.json`;
- capability statements match `@remotish/adapter-sdk`;
- version-specific Code-OSS details match package/extension pins;
- security/release claims match workflow behavior;
- examples do not require imports from package internals.
