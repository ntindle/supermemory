# Recall quality benchmark

A repeatable regression benchmark for the self-hosted server. It measures whether
we retrieve the right source documents **and** whether a fixed reader can answer
from the returned context. Run before and after a proposed memory change, using
the same corpus, questions, reader, judge and context budget.

[First measured baseline (2026-10-24)](results/2026-10-24/README.md): all five
conditions, failure analysis, calibration, comparison intervals and JSON artifacts.

The initial suite has **21 synthetic documents, 24 questions and six independent
memory spaces**. It covers changed preferences/settings, historical questions,
multi-document answers, exact identifiers, negation, duplicates, scope isolation,
unknown facts and a deleted fixture. Twelve questions are development cases and
twelve are a public, frozen holdout group. Both groups were inspected while
validating the harness, so neither is an unseen generalization test. This is a
small regression suite, not a
LongMemEval/LoCoMo leaderboard result or a measurement of private production data.

## What is measured

| Measurement            | Definition                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Source Recall@5/@10    | Fraction of annotated relevant source documents found in the first 5/10 unique source ranks.                      |
| Source MRR / nDCG@10   | First relevant source rank / graded source ranking quality.                                                       |
| Answer accuracy        | Strict judge correctness against a fixed reference; failures remain in the denominator.                           |
| Grounded accuracy      | Correct answers whose claims are supported by the supplied context. Citation syntax is reported separately.       |
| Abstention             | `abstentionAccuracy` measures unknown/scope/deleted cases; `answerableAccuracy` scores positive cases separately. |
| Isolation              | Reject foreign source IDs or another space's canary before calling the reader/judge.                              |
| Duplicate rate         | Exact returned-text duplication after whitespace normalization, preserving case-sensitive identifiers.            |
| Stale-context rate     | An annotated superseded token appeared in context; this is a risk indicator, not necessarily a wrong answer.      |
| Latency                | Wall-clock retrieval p50/p95 and count over 3 seconds, with three seeded, interleaved repeats.                    |
| Context / model tokens | Budgeted context tokens and provider-reported reader + judge usage; extraction usage is excluded.                 |

Search results can cite multiple documents. Their provenance is expanded in API
order, retaining each source once; cutoff ranks refer to **documents**, not memory
hits. The duplicate-source fixtures intentionally have three relevant documents
containing the same fact. Finding any one may answer correctly while source recall
is below 100%. Source recall does not establish that a retrieved memory contains
the requested fact; that is why answer evaluation is separate.

Questions with no relevant source have null retrieval metrics, never perfect
recall. Missing provenance is reported as `unmappedHits`; those rows have no source
score. `sourceScoredQuestions` exposes this coverage. Profile text has no document
provenance, so its source scores describe only the endpoint's search results.
Canaries detect selected profile leaks; their absence is not a complete security
proof. Deleted fixtures test the API's actual removal behavior.

`abstentionAccuracy` requires both a correct judgment and the explicit reader
`abstain` flag. A semantically correct “not recorded” answer with that flag set
false can pass answer accuracy while failing this stricter contract check.

## Conditions and controls

- `profile`: `/v4/profile` static + dynamic profile, followed by query results.
- `memories`: `/v4/search` with `searchMode=memories`.
- `hybrid`: `/v4/search` with `searchMode=hybrid`.
- `closed-book`: empty context, checking unsupported guesses and abstention.
- `oracle`: known relevant source documents, checking the reader/grader ceiling.

The default search limit is 10, threshold 0.6, and context budget 2,200 tokens.
The profile API does not expose a limit; its returned search results are truncated
to the same limit locally. All context is packed in API order without consulting
the reference answer or relevance labels. `cl100k_base` is the **budgeting**
tokenizer; proprietary model usage can differ. Reranking and query rewriting are
disabled. Retrieval samples are collected before reader/judge traffic; the first
sample feeds QA and all three contribute latency. There is no separate warm-up.

The reader receives only the question and context. Only the judge sees the
reference answer. Reader/judge models and prompts are fixed across conditions.
Malformed, truncated or failed responses are errors, never guessed scores.
Eight fixed calibration cases exercise the judge before trusting a run.
LLM judgments are still fallible; inspect failures and the oracle/control scores.
Model IDs may be provider aliases, and inference/extraction is stochastic. This
records repeatable conditions, not a guarantee of identical generated outputs.

## Run on a disposable copy

Requires Docker, Bun 1.3.4 or 1.4.0, a few GiB of disk, and about 4 GiB RAM for the
two containers. This directory is a standalone package; it uses whole-package
Prettier instead of the root SDK/web Biome configuration.

```bash
cd evals/recall
bun install --frozen-lockfile
bun run format:check
bun run check-types
bun test
```

Keep inputs, credentials and output beneath a private directory outside Git.
Credentials must be files with mode 0600 or stricter. `stack-start` accepts an input
JSON containing `environmentFile`, `extractionModel`, `reader` and `judge`:

```json
{
  "environmentFile": "/absolute/private/provider.env",
  "extractionModel": "your-extraction-model",
  "reader": {
    "baseUrl": "https://your-gateway.example/v1",
    "keyFile": "/absolute/private/model-key",
    "model": "your-reader-model",
    "reasoningEffort": "low"
  },
  "judge": {
    "baseUrl": "https://your-gateway.example/v1",
    "keyFile": "/absolute/private/model-key",
    "model": "your-judge-model",
    "reasoningEffort": "low"
  }
}
```

`provider.env` contains exactly `OPENAI_MODEL`, `OPENAI_API_KEY` and
`OPENAI_BASE_URL`, with the declared extraction model. Other environment overrides
are rejected so an existing database cannot be selected accidentally. Optional
`extraHosts` entries support the Gateway's Tailscale name inside Docker. Reader
and judge use an OpenAI-compatible `/chat/completions` endpoint with JSON output;
use a different judge model where available. These runs make real inference calls.

```bash
bun cli.ts stack-start /absolute/private/inputs.json /absolute/private/stack
bun cli.ts calibrate /absolute/private/stack/config.private.json /absolute/private/calibration.json
bun cli.ts prepare /absolute/private/stack/config.private.json /absolute/private/corpus
bun cli.ts run /absolute/private/stack/config.private.json /absolute/private/corpus /absolute/private/baseline
bun cli.ts compare /absolute/private/baseline/report.json /absolute/private/baseline/report.json profile hybrid /absolute/private/comparison.json
bun cli.ts stack-stop /absolute/private/stack
```

The stack pins the released `0.0.8-ntindle.1` image and pgvector image by digest,
generates fresh credentials, creates an empty native PostgreSQL database, and
binds the app to a random **loopback** port. No production data is copied. The app
has 3 GiB/2 CPUs; PostgreSQL has 1 GiB/2 CPUs. Stop verifies container ownership
labels and retains all data/artifacts. It never removes other stacks or caches.
On a failed start, `stack.json` identifies any owned resources requiring cleanup.

You can instead supply a private `Config` JSON (see `types.ts`) for a separately
isolated compatible server. It must declare the deployed image and extraction /
embedding model identities. Remote targets require explicit `allowRemote: true`;
use a disposable account/namespace and do not substitute your production corpus.
Each prepare run creates unique `sm_eval_*` spaces. Chronological extraction is
sequential within each space, with at most two spaces active. Preparing over 100
documents is rejected; use the MemoryBench adapter for larger public datasets.

## Compare and retain evidence

`prepare` journals document IDs and indexing status. Resuming verifies target,
credentials, deployment and suite identity. An ambiguous POST is resolved by its
unique custom ID, never blindly appended again. Unresolvable ownership/ingestion
failures require a fresh isolated run. Only the synthetic deletion fixture is
removed, after checking its run ownership.

`run` records protocol/harness/prompt/suite hashes, declared deployment and models,
settings, per-case retrieval traces, model answers and judgments. It checkpoints
each result. Reusing the same output directory resumes unfinished work without
regrading completed cases, including errors. To retry errors, retain the failed
run and repeat the whole comparison in a new output directory; do not keep only
the best answers. Do not share private traces or inputs from non-synthetic suites.

Run only one process per corpus/output directory; simultaneous writers are not
supported. Use distinct directories and run IDs for concurrent experiments.

`compare` refuses missing cases, evaluator/model/budget drift, errors and isolation
failures. The default requires one prepared corpus. For explicit extraction/model
or deployment comparisons, use `--allow-different-corpus` and record both declared
deployments; stochastic ingestion is then part of the experiment. It reports
paired grounded-accuracy change and a 5,000-sample bootstrap interval resampling
**whole memory spaces**, because questions sharing memories are correlated.
Six spaces give weak statistical power; these intervals are descriptive.

Tune on development cases; keep the holdout frozen. After inspecting holdout
failures, improvements need new unseen cases for an unbiased confirmation. Add
new suites with versioned IDs; never silently change an old baseline's questions,
answers or qrels. Retain latency/context/abstention and scope checks alongside any
accuracy gain. CI tests the harness without credentials or external model calls.

## MemoryBench / LongMemEval / LoCoMo

[`memorybench-provider.ts`](memorybench-provider.ts) implements the structural
provider interface from [MemoryBench](https://github.com/supermemoryai/memorybench)
commit `063b86bfb347336def3a084153f40bfea1e2dfd6`. Its upstream Supermemory adapter
currently uses v5; our release exposes v3/v4. This adapter uses v3 ingestion and
v4 search, low concurrency, bounded indexing, content-checked duplicate avoidance,
and cleanup restricted to IDs ingested by that instance. It preserves input
session order and waits for extraction between sessions. It does not forward
arbitrary session/question metadata into memory content.

In an isolated checkout of that MemoryBench commit, replace the Supermemory
provider import in `src/providers/index.ts` with an import of
`FactorySupermemoryProvider as SupermemoryProvider` from this file's absolute path.
Set `SUPERMEMORY_BASE_URL` and `SUPERMEMORY_API_KEY` through your private environment.
Pass a **non-secret** provider config with a fresh `runId` (16–64 safe characters)
and `searchMode` (`hybrid` or `memories`) using `--provider-config path.json`. Keep
that same runId when resuming. Unknown settings fail instead of being ignored.
Never place credentials in MemoryBench's provider config: upstream logs it.

Use MemoryBench's benchmark-specific prompts and report [LongMemEval](https://github.com/xiaowu0162/LongMemEval)
or LoCoMo results separately, with dataset revision/split, models, sample IDs and
settings. A limited smoke sample is not a full benchmark result. Upstream's
LLM-labelled retrieval evaluator estimates relevance from retrieved chunks; its
reported “recall” is not our corpus-ground-truth source recall. The adapter has
interface and real API smoke validation; full public-dataset runs are separate.
