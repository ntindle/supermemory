# Validation record — 2026-10-23

**Verified locally:** an isolated migration and candidate server. The production
service was not migrated by this work. The tested launcher, executable and
PostgreSQL image digests are in [pins.json](pins.json).

| Check              | Evidence                                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full copied store  | All 21 application tables matched exact counts and sorted row fingerprints before/after migration: 698 documents and 174,409 memories. 423.982 seconds.                                 |
| Native storage     | PostgreSQL 17.11, pgvector 0.8.7; candidate creates no PGlite database or whole-store snapshots.                                                                                        |
| Permissions        | Real server and bundled Drizzle probes pass as a dedicated non-superuser owner.                                                                                                         |
| Transactions       | Four actual bundled Drizzle transactions reserve four distinct connections; nested and outer rollback pass.                                                                             |
| API contract       | Authentication and forged loopback Host rejection, tag isolation, document provenance, search and profile-with-query pass.                                                              |
| Ingestion          | Real LLM extraction and sequential append preserve document identity, old facts and new facts.                                                                                          |
| Concurrent append  | Reproduced data loss before repair: three successful HTTP responses retained only the last appended text. Patched candidate retains all three.                                          |
| DB crash           | PostgreSQL SIGKILL: committed probe survives, open transaction rolls back. Application detects ownership loss and exits. Native fsync, full-page writes and synchronous commit enabled. |
| Restart            | App and database restart retain API recall. Test harness resolves dynamic published ports after restart.                                                                                |
| Warm local latency | During ingestion: 1/4/8 concurrent profile queries, p95 48/309/227 ms, maxima 48/309/240 ms. 39 requests, none over 3 seconds.                                                          |
| Memory sample      | Candidate app about 1.19 GiB, database about 198 MiB at one observed point; not a sustained resource ceiling.                                                                           |

**Verified:** 22 tests / 89 assertions pass on Bun 1.3.4 and 1.4.0. Full package
formatting, repository validation, shellcheck and whitespace checks pass. The
lockfile is compatible with the embedded Bun 1.3.4 runtime.

**Verified forget:** both synthetic fixtures were deleted through the API; scoped
search and profile recall returned no residual facts. Foreign-key cascade tests
also verify removal of pending captures and encrypted workflow inputs.

**Verified full-server failures:** SIGKILL immediately after PostgreSQL COMMIT,
before workflow dispatch, leaves the encrypted workflow input durable. Restart
schedules the missing actor and preserves both the earlier document and exactly
one copy of the new capture. A separate barrier after acceptance but before queue
acknowledgement also recovers without a duplicate. Typed Rivet `actor/not_found`
errors permit recovery even when its HTTP status is 500; other engine failures
remain fail-closed. Three simultaneous initial captures create one document with
all three pieces of content. Final concurrent append and recall pass again on the
pinned output executable. Two simultaneous identical captures also drain to one
copy of the content; their synthetic document is then forgotten successfully.

**Standard launcher smoke:** passed all checks on retry. The first attempt hit a
Bun 1.3.4 segmentation fault while reopening the unchanged upstream 0.0.9 embedded
store. This patch does not change that default deployment path; the incident is
retained here rather than treating a retry as evidence that the flake is fixed.

**CI:** a dedicated PostgreSQL job is included; consult the PR for remote check
status. The locally validated runtime is opt-in and has not been deployed to
production.

The latency measurements use warm embeddings and loopback HTTP on the test host.
They do not measure production Tailscale transport, cold model loading, sustained
load or weeks of operation. Database-only tests use fake workflow callbacks;
full-server checks additionally exercise the shipped Bun 1.3.4 executable, real
Drizzle, real Rivet and the configured LLM provider.

The failure tests led to fixes for native `public` schema restoration, pg_dump
login, precise row transfer, connection reservation, partial provisioning failures,
concurrent appends, busy-capture persistence, deletion of queued content, queue
capacity/fairness and the database-to-workflow handoff. None requires changing the
Gateway or client credentials.

## Repository relocation

The verified runtime and migration/test modules were moved without content changes
from `ntindle/unraid-apps` commit `fc98a1c` into this upstream fork at Nick's
request. The original [five green checks](https://github.com/ntindle/unraid-apps/actions/runs/40037258542)
remain historical evidence; this fork runs its own dedicated PostgreSQL checks.
The migration and real-server evidence above still describes the same pinned
runtime, not a second production deployment.
