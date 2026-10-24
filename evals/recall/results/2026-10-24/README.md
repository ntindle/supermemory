# First published baseline — 24 October 2026

All **120 question/condition evaluations** completed with no transport, parsing,
indexing or scope errors. Hybrid answered all 24 questions correctly with support
in the supplied context. This small synthetic suite establishes a regression
baseline; it does not establish cloud parity or general retrieval superiority.

| Condition           | Correct + grounded | Answerable only | Source Recall@10 | Retrieval p95 | Mean context tokens |
| ------------------- | ------------------ | --------------- | ---------------- | ------------- | ------------------- |
| Profile + search    | 23/24 (95.8%)      | 19/20           | 83.3%            | 52.0 ms       | 427                 |
| Memory-only search  | 22/24 (91.7%)      | 18/20           | 83.3%            | 39.8 ms       | 102                 |
| Hybrid search       | 24/24 (100%)       | 20/20           | 93.3%            | 39.2 ms       | 161                 |
| No-memory control   | 4/24 (16.7%)       | 0/20            | —                | —             | 0                   |
| Known-source oracle | 24/24 (100%)       | 20/20           | —                | —             | 57                  |

Source Recall@10 averages 20 answerable questions. The two duplicate-source
questions each have three relevant documents containing the same fact; every
method returned provenance for one copy. This accounts for hybrid's remaining
6.7 percentage points of source recall loss despite correct answers. All 21
fixture documents have distinct server IDs. Profile scores refer to its search
results, not its unattributed standing profile.

Every method correctly avoided inventing the four unknown/scope/deleted answers.
However, **all three retrieval modes set `abstain: false` on q16** while answering
“No allergy information has been recorded for Ren.” Semantic correctness passed;
the separately measured **explicit abstention flag passed 3/4 (75%)**. Controls
passed 4/4. A consumer relying on that flag needs this distinction.

## What the failures show

- Memory-only search missed q04 (old service port) and q18 (original trip plan).
  Both had empty retrieved context. These are historical facts, superseded by
  newer settings/plans.
- Profile mode missed q18. It included the earlier destination/date within later
  update text, but labelled those profile entries with the ingestion date,
  2026-10-24. The reader abstained on a question asking about 2026-08-10. The source
  document's stored `temporalContext.documentDate` was correctly 2026-08-10;
  profile presentation did not preserve that distinction.
- Hybrid returned the original source chunk and answered both historical cases.
  There were no paired answer regressions on this suite.

The measured hybrid gain is **+4.2 percentage points over profile** and **+8.3 over
memory-only**. Bootstrap intervals resampling the six whole memory spaces are
respectively **[0, +15.0]** and **[0, +16.1]** percentage points. Both include zero;
24 questions are insufficient for a broad superiority claim. Historical retrieval
and profile dates are useful next targets for a larger evaluation.

## Conditions and validation

- Code: `3a94ffe2bc79ff4946ac7be57980b2268a176f2f`; policy/suite `factory-recall-v2`.
  The report's hashes match the frozen evaluator, prompts, suite and settings.
- Server: published `0.0.8-ntindle.1`, pinned by digest; native PostgreSQL/pgvector.
  An isolated local Docker stack used no production data and is now stopped.
  App: 3 GiB/2 CPUs; database: 1 GiB/2 CPUs, on a Linux x64 VM. Prior pilot
  namespaces were retained separately. These timings do not describe the large
  production database or an end-user hook.
- Extraction and reader requested `gpt-5.6-luna`; independent judge requested
  `gpt-6.1-sol`. Reader/judge reasoning effort `low`, maximum output 4,096 tokens.
  Model IDs are provider aliases, not immutable weight revisions.
- Top 10 hits, threshold 0.6, 2,200 context-token cap using `cl100k_base`, no
  reranking/query rewriting. One stochastic ingestion shared by all conditions;
  one reader/judge sample per case. Three seeded retrieval repeats, 216 actual
  search/profile requests, no warm-up. Returned context was stable across repeats.
- Judge calibration: **8/8** fixed expected-label cases. Harness tests: **16/16**
  on Bun 1.3.4 and 1.4.0; TypeScript and whole-package formatting pass.
- Zero detected scope leaks, missing source provenance, malformed model responses
  or invalid citation IDs. No retrieval request exceeded three seconds. Exact
  duplicate returned-text rate was zero; this does not measure production's
  existing duplicate population. Canary checks are not a security proof.
- MemoryBench adapter matched the pinned upstream Provider interface and passed
  real ingest/index/search/repeated-ingest/owned-cleanup checks. Full LongMemEval,
  LoCoMo and cloud-service comparisons have **not** been run.

## Pilot corrections

The unpublished v1 pilot was excluded from the baseline. Its q03 inferred that a
maintainer was responsible for restore verification, which its source never
stated. V2 asks for the maintainer and verification phrase explicitly. Its q06
reference included allowed weekdays not requested by the question; v2 requires
only the Friday prohibition. Citation formatting had also been conflated with
semantic grounding; v2 records syntax separately and clarifies bare source IDs.

The whole corpus was prepared again under new tags and **every condition was
rerun** with the corrected frozen suite/prompts. No successful pilot answers were
selected into v2. Both development and nominal holdout cases were inspected
during harness validation; the holdout label does not imply unseen evaluation.

## Artifacts

- [Complete scores, answers, judgments and protocol](report.json)
- [Overall, category and split summaries](summary.json)
- [Profile versus hybrid](profile-vs-hybrid.json)
- [Memory-only versus hybrid](memories-vs-hybrid.json)
- [Judge calibration](judge-calibration.json)
- [MemoryBench adapter smoke](adapter-smoke.json)
- [Deployment and sampling provenance](provenance.json)

These artifacts contain only synthetic fixture content and safe deployment/model
metadata. Credentials, raw server logs and private endpoints are excluded.
