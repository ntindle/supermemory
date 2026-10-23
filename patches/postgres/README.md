# External PostgreSQL for the pinned local server

This opt-in compatibility patch runs the reviewed **Supermemory server 0.0.8,
linux-x64** against PostgreSQL 17 and pgvector 0.8.x. It uses the native Postgres
adapter already bundled in that executable. The Unraid launcher is maintained separately in
[ntindle/unraid-apps](https://github.com/ntindle/unraid-apps). This is a local patch to a published executable, not the source of
Supermemory's hosted service or an upstream-supported configuration.

[Validation and limits](validation.md) records the tests against an isolated copy
of a populated store. Generated binaries, databases, keys and logs stay outside Git.

## What changes

- A bounded native connection pool replaces the embedded WASM database. PostgreSQL
  owns WAL, checkpoints and autovacuum; there is no whole-store snapshot timer.
- Transactions use the **bundled** `pg.Pool` constructor. Bundled Drizzle tests its
  constructor identity; substituting an independently installed `pg` pool would
  silently defeat transaction connection reservation.
- A database ownership lock prevents two local servers using one database. Losing
  that connection stops the app. Startup verifies the migrated machine identity,
  supported server/extension versions and a completed migration marker.
- Same-session writes serialize in SQL. Text appends received during processing
  are saved in an encrypted FIFO queue instead of being skipped or overwritten.
  The validated API handles delivery. Pending retries deduplicate; a failed or
  full queue rejects further captures rather than acknowledging lost content.
- The exact workflow input commits alongside its document in an encrypted outbox.
  Stable Rivet actor IDs let restart recovery find existing work or schedule a
  missing handoff. The receipt prevents re-appending accepted content.
- Deleting a document cascades to its deferred inputs. A stale delivery cannot
  create it again. Authentication, host guard and upstream validation/licensing
  remain in the request path.

The database's document and memory tables are **not encrypted by this patch**.
Use appropriate encrypted storage/backups and database transport for your setup.
Queue/outbox encryption does not make PostgreSQL data files encrypted. The
`machine-key`, API key, uploads, embedding cache and Rivet state still belong in
persistent App Data alongside the external database's backups.

## Build a reproducible bundle

Use Bun 1.3.4 (the embedded runtime) or the tested Bun 1.4.0, Docker and a private
working directory. `pins.json` records the exact executable, launcher and images.
The patcher rejects any other executable, existing destination or unexpected
layout, and verifies the complete patched executable's SHA-256.

```bash
cd patches/postgres
bun install --frozen-lockfile
# ORIGINAL is the original 0.0.8 executable downloaded from its official release.
# LAUNCHER is /usr/local/bin/entrypoint.sh extracted from pins.json's launcher image.
bun bundle.mjs build "$ORIGINAL" "$LAUNCHER" "$NEW_BUNDLE"
bun bundle.mjs verify "$NEW_BUNDLE"
```

`--with-probe` adds a test initializer that checks the **actual bundled Drizzle**
with four concurrent transactions, nested rollback and outer rollback. Enable it
only in an isolated test container by setting
`FACTORY_SUPERMEMORY_RUNTIME=file:///data/postgres/runtime-probe.mjs` and
`FACTORY_PROBE_RESULT` to a private output path. Omit these overrides for normal use.

Only our adapter files and patch instructions are distributed here. Obtain the
server from [the official releases](https://github.com/supermemoryai/supermemory/releases).
Its original license still applies, including document limits.

## Migrate an offline copy

The importer accepts the **encrypted `pages.sqlite` backend** from the incremental
page-store repair. It does not accept an original `store/data` encrypted archive or
an arbitrary 0.0.9 store. First convert/recover an older archive using its matching
repair procedure. Never point the importer at a live App Data directory.

1. Stop the source app cleanly, retain a complete untouched backup, and make a
   separate working copy including `pages.sqlite` and `machine-key`. Copy the
   entire stopped store so SQLite companions and workflow state stay consistent.
2. Start a dedicated, empty PostgreSQL 17/pgvector database using the image in
   `pins.json`. Bind the private working directory into its tools container at
   **the same absolute path**: `--volume "$WORK:$WORK"`. The importer exposes the
   copied PGlite store through a private Unix socket for schema export. Keep the
   database reachable only through your intended private transport.
3. Put an admin connection URL in a mode-600 file. Do not pass secrets in command
   arguments. Run from this package:

   ```bash
   bun migrate.mjs "$SOURCE_COPY" "$ADMIN_URL_FILE" "$PG_CONTAINER" "$NEW_EVIDENCE_DIR"
   ```

   The admin URL and tools container must address the same cluster/database. The
   importer checks their cluster identifiers and refuses a nonempty destination.
   It exports schema, copies bounded batches of exact SQL JSON, restores indexes,
   foreign keys and sequences, then compares **every table's count and sorted
   row fingerprints** with the source before and after. Only an exact match writes
   the machine-binding marker that permits app startup. Diagnostics and exported
   schema can contain private data; retain them privately.

4. Provision a dedicated non-superuser application owner, supplying a random
   password of at least 24 characters in another private file:

   ```bash
   bun provision-role.mjs "$ADMIN_URL_FILE" supermemory_app "$PASSWORD_FILE" "$NEW_APP_URL_FILE"
   ```

   This transfers only the verified application's database, schemas and objects.
   pgvector stays admin-owned. The role needs object ownership for future upstream
   schema migrations; it has no superuser, role-creation or database-creation power.

5. Prepare a separate App Data copy retaining the original machine/API keys,
   embedding plan, uploads and workflow state. Install the verified bundle at
   `/data/postgres`. Configure the app's connection file for the database hostname
   reachable **inside its container**, and make it readable by UID 99. A host-side
   loopback URL used for migration is not the container's database URL.
6. Pin the launcher image from `pins.json`, set `SUPERMEMORY_VERSION=0.0.8`, keep
   the original provider configuration, and use `/data/postgres/launch.sh` as the
   entrypoint. Set `FACTORY_SUPERMEMORY_DATABASE_URL_FILE` to the mounted secret
   file. Pool size defaults to 8 and can be set from 2 through 32 using
   `FACTORY_SUPERMEMORY_PG_CONNECTIONS`. Use `--init` and a 120-second stop timeout.
   Keep the host guard enabled; put the API behind your existing private endpoint.
7. Validate ingestion, search/profile recall, append, restart and forget on the
   isolated candidate before switching clients. A final cutover requires a fresh
   stopped-source copy; an earlier test snapshot will miss subsequent writes.

The source archive/page copy is a rollback snapshot, not an ongoing replica.
Once PostgreSQL accepts new writes, returning to that old copy loses those writes.
Keep a current PostgreSQL backup plus the matching App Data. Do not apply a
normal launcher/server upgrade without reviewing new pins, migrations and hooks.

## Tests

From the repository root:

```bash
scripts/test-supermemory-postgres.sh
```

The command creates only its own temporary PG container/database, tests
lossless migration (including large exact numbers, generated columns, identity
sequences, HNSW and foreign keys), transactions, queue and outbox behavior, then
removes its test resources. It also checks formatting for the whole package.
It needs Docker, Bun and OpenSSL. To exercise an extracted Bun executable, set
`BUN_BIN` and `BUN_BE_BUN=1`. CI uses Bun 1.3.4.

Launcher template validation and container smoke tests remain in
[ntindle/unraid-apps](https://github.com/ntindle/unraid-apps). The patch package is
independent of the upstream SDK/web workspaces and keeps its reviewed ESM files,
Bun lockfile and whole-package Prettier checks.

Full-server checks need a working LLM provider and are separate from these
synthetic database tests. `contract-check.mjs` accepts `write`, `append-parallel`,
`create-parallel`, `check`, `forget`, `crash-handoff` and `latency`, followed by an API base URL (or `docker:CONTAINER`),
an API-key file and a private fixture-state path. It creates/deletes only its own
`factory_pg_probe_*` document and checks auth, tag isolation, provenance and
profile-with-query recall. `enqueue` creates a fixture for a process-crash test.
`crash-handoff` requires the test-only initializer, a Docker address and
`FACTORY_TEST_PG_URL_FILE`. It arms a deterministic SIGKILL immediately after the
real document transaction commits, checks the saved workflow input, restarts the
candidate and verifies exactly one recovered capture. Use only an isolated copy.
The latency mode additionally takes `FACTORY_TEST_RECALL_TAG` for a populated tag.

## Queue operations and limits

The compatibility queue protects text appends with `customId`. Busy full
replacements return an error for retry; unresolved failed workflows must be retried
before appending more content; URL/file handling retains the upstream
behavior. A maximum of 256 pending captures is allowed per document. Two documents
can dispatch concurrently; other API traffic uses the rest of the bounded pool.
This fixes persistence and serialization, not LLM throughput or extraction quality.

Inspect only safe aggregate metadata during routine operation:

```sql
SELECT state, count(*), max(last_error)
FROM drizzle.__factory_ingest_queue GROUP BY state;
SELECT count(*) FROM drizzle.__factory_workflow_outbox;
```

Failed captures retain their encrypted payload for investigation. After fixing
the cause, retry a **specific reviewed row** by setting `state='pending'`,
`attempts=0`, `last_error=NULL`, `available_at=now()`. Do not bulk-clear queues or
copy machine keys between unrelated instances. Completed queue envelopes are
cleared; receipt rows expire after seven days. Completed workflow inputs are
removed. Failed workflow inputs remain for diagnosis and upstream retry.

This patch supports one local app process per database. It is not a multi-node
Supermemory deployment. Startup locking and crash tests do not establish
weeks-long production reliability; monitor the real service after a deliberate
cutover.
