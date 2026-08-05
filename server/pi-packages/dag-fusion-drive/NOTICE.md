# Provenance and notices

`dag-fusion-drive` is an original implementation built for the K-Dense BYOK
typed DAG runtime from public Pi and `pi-subagents` interfaces. The implementation
does not copy prompts, source, tests, fixtures, comments, or assets from
`claude-fusion-drive`. That clean-room boundary is intentional because the
latter repository carries additional redistribution terms that are unsuitable
for an upstream K-Dense contribution.

The package is distributed under the repository MIT license. Runtime peers are
not vendored into a package tarball:

- `@earendil-works/pi-coding-agent` supplies the Pi extension API; and
- `pi-subagents` supplies the versioned Delegation V2 event contract.

Their own license files and notices remain authoritative when an installer
resolves those peer packages. Before any public release, regenerate the packed
file list and dependency/license inventory rather than relying on this
incubating snapshot.
