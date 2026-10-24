# ntindle/supermemory

This is a GitHub fork of [supermemoryai/supermemory](https://github.com/supermemoryai/supermemory).
The fork owns the local self-hosted server patches. The Unraid image, templates
and container launcher remain in [ntindle/unraid-apps](https://github.com/ntindle/unraid-apps).

## Maintained patches

[`patches/postgres/`](patches/postgres/README.md) contains the checksum-pinned 0.0.8
PostgreSQL adapter, offline lossless migration, durable capture queue and workflow
handoff fixes. Its runtime modules were moved unchanged from `unraid-apps` commit
`fc98a1c`, with the same tested binary output hash. Build instructions, pins,
operational limits and the original validation evidence are in that directory.

The public upstream checkout contains SDKs, integrations, UI and documentation;
the self-hosted executable is obtained from its release. These patches operate on
that reviewed executable. This repository does not redistribute generated server
binaries or imply access to the hosted service's implementation. The upstream
server license remains applicable. The imported patch layer retains its
[MIT license](patches/postgres/LICENSE).

## Recall quality

[`evals/recall/`](evals/recall/README.md) measures source retrieval, grounded answer
accuracy, isolation, latency and context size on fixed synthetic memories. It
includes no-memory and oracle controls, strict grading, comparison checks and a
v3/v4 adapter for MemoryBench. The evaluator runs against disposable copies of
the published image; it does not change the server or require production data.

## Development

The patch is an independent Bun package outside the SDK/web workspaces. It keeps
the reviewed ESM modules consumed directly by the released Bun 1.3.4 executable.
The root Biome configuration excludes this directory because its own pinned
Prettier check covers the entire package; reformatting it through a second tool
would make the copied runtime checksums drift.

From the repository root, run:

```bash
scripts/test-supermemory-postgres.sh
shellcheck scripts/*.sh patches/postgres/launch.sh
git diff --check
```

The test runner installs its frozen dependencies, creates its own temporary
PostgreSQL service, runs all migration/runtime/queue tests and whole-package
format checks, then removes only its test resources. The dedicated workflow runs
on both Bun 1.3.4 and 1.4.0. Full-server LLM tests remain a separate private
validation step; see the package's validation record.

For upstream SDK/web changes, follow [CONTRIBUTING.md](CONTRIBUTING.md). Sync
upstream using normal merges, never a rebase or force push. Review changed binary
and launcher pins explicitly before supporting another server version. Generated
bundles, private data, credentials and logs stay out of Git.
