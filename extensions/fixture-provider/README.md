# Remotish fixture provider

Browser extension that exposes the deterministic `FixtureAdapter` through the public Remotish provider contract.

It is intentionally separate from the Remotish host. The provider is discovered from its `remotish.provider` manifest marker, activates lazily, and opens the demo repository through `remotish.openRepository`. Its `restoreWorkspace` implementation lets canonical `remotish://.../` workspaces recover through the same provider-discovery path used by production providers.
