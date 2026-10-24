import fs from "node:fs";
import path from "node:path";
import { MemoryClient } from "./client.ts";
import { buildContext, scopeLeak } from "./context.ts";
import { aggregate, sourceMetrics } from "./metrics.ts";
import {
  chat,
  JUDGE_PROMPT,
  parseAnswer,
  parseJudgment,
  READER_PROMPT,
  readerInput,
} from "./prompts.ts";
import {
  hash,
  newDirectory,
  random,
  readJson,
  secret,
  settings,
  shuffled,
  targetIdentity,
  validateSuite,
  writeJson,
} from "./util.ts";
import type {
  Config,
  Evaluation,
  Manifest,
  Mode,
  Report,
  Retrieval,
  Suite,
} from "./types.ts";

export const MODES: Mode[] = [
  "profile",
  "memories",
  "hybrid",
  "closed-book",
  "oracle",
];
export const POLICY = "factory-recall-v2";
export function protocol(config: Config, suite: Suite) {
  const model = (c: Config["reader"]) => ({
    model: c.model,
    endpointHash: hash(c.baseUrl),
    reasoningEffort: c.reasoningEffort ?? null,
    maxTokens: c.maxTokens ?? 4096,
  });
  const harnessHash = hash(
    [
      "client.ts",
      "context.ts",
      "metrics.ts",
      "prompts.ts",
      "prepare.ts",
      "runner.ts",
      "util.ts",
    ].map((name) => [
      name,
      fs.readFileSync(path.join(import.meta.dir, name), "utf8"),
    ]),
  );
  return {
    policy: POLICY,
    harnessHash,
    suiteHash: hash(suite),
    questionIds: suite.questions.map((q) => q.id).sort(),
    reader: model(config.reader),
    judge: model(config.judge),
    readerPromptHash: hash(READER_PROMPT),
    judgePromptHash: hash(JUDGE_PROMPT),
    tokenizer: "js-tiktoken@1.0.21/cl100k_base",
    ...settings(config),
  };
}
export function summaries(report: Report) {
  return Object.fromEntries(
    report.modes.map((mode) => {
      const rows = report.rows.filter((r) => r.mode === mode);
      return [
        mode,
        {
          all: aggregate(rows),
          splits: Object.fromEntries(
            ["development", "holdout"].map((split) => [
              split,
              aggregate(rows.filter((r) => r.split === split)),
            ]),
          ),
          categories: Object.fromEntries(
            [...new Set(rows.map((r) => r.category))]
              .sort()
              .map((category) => [
                category,
                aggregate(rows.filter((r) => r.category === category)),
              ]),
          ),
        },
      ];
    }),
  );
}
type Sample = { retrieval?: Retrieval; error?: string };
export async function run(
  config: Config,
  corpusDir: string,
  output: string,
  modes: Mode[],
) {
  if (
    !modes.length ||
    new Set(modes).size !== modes.length ||
    modes.some((m) => !MODES.includes(m))
  )
    throw new Error("Invalid/duplicate evaluation modes");
  const suite = readJson<Suite>(path.join(corpusDir, "suite.json"));
  validateSuite(suite);
  const manifest = readJson<Manifest>(path.join(corpusDir, "manifest.json"));
  if (
    !manifest.prepared ||
    manifest.suiteHash !== hash(suite) ||
    manifest.targetIdentity !== targetIdentity(config) ||
    hash(manifest.deployment) !== hash(config.deployment)
  )
    throw new Error(
      "Prepared corpus does not match target, suite or deployment",
    );
  const contract = protocol(config, suite);
  const header = {
    schema: 1 as const,
    createdAt: new Date().toISOString(),
    protocol: contract,
    corpusId: manifest.runId,
    deployment: manifest.deployment,
    modes,
    runtime: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
  const headerFile = path.join(output, "run.json");
  if (fs.existsSync(output)) {
    const old = readJson<typeof header>(headerFile);
    if (
      hash(old.protocol) !== hash(contract) ||
      old.corpusId !== manifest.runId ||
      hash(old.modes) !== hash(modes) ||
      hash(old.deployment) !== hash(manifest.deployment)
    )
      throw new Error("Resume conditions differ; use a new output directory");
    header.createdAt = old.createdAt;
  } else {
    newDirectory(output);
    fs.mkdirSync(path.join(output, "rows"), { mode: 0o700 });
    fs.mkdirSync(path.join(output, "traces"), { mode: 0o700 });
    writeJson(headerFile, header);
  }
  const client = new MemoryClient(
    config.baseUrl,
    secret(config.keyFile),
    config.allowRemote,
    15000,
    Object.fromEntries(
      Object.entries(manifest.documents).flatMap(([id, doc]) => [
        [doc.id, id],
        [doc.customId, id],
      ]),
    ),
  );
  const params = settings(config);
  const samplesFile = path.join(output, "retrievals.private.json");
  const samples: Record<string, Sample[]> = fs.existsSync(samplesFile)
    ? readJson(samplesFile)
    : {};
  // Complete retrieval timings before reader/judge traffic. Seeded interleaving
  // avoids systematically giving one method a cold cache. Sample 0 feeds QA.
  const jobs = modes.flatMap((mode) =>
    suite.questions.map((question) => ({
      mode,
      question,
      key: `${mode}--${question.id}`,
    })),
  );
  const rng = random(params.seed);
  for (let repeat = 0; repeat < params.repeats; repeat++) {
    for (const job of shuffled(jobs, rng)) {
      if (samples[job.key]?.[repeat]) continue;
      let sample: Sample;
      try {
        const retrieval: Retrieval =
          job.mode === "closed-book"
            ? { hits: [], profile: [], ms: 0 }
            : job.mode === "oracle"
              ? {
                  hits: suite.documents
                    .filter((d) => job.question.sources[d.id])
                    .map((d) => ({
                      id: d.id,
                      sources: [d.id],
                      text: `Source date: ${d.date}. ${d.content}`,
                    })),
                  profile: [],
                  ms: 0,
                }
              : await client.retrieve(
                  job.question.question,
                  manifest.spaces[job.question.space],
                  job.mode,
                  params.topK,
                  params.threshold,
                );
        sample = { retrieval };
      } catch (error) {
        sample = {
          error: error instanceof Error ? error.message : "Retrieval failed",
        };
      }
      (samples[job.key] ??= [])[repeat] = sample;
      writeJson(samplesFile, samples);
    }
    console.log(
      JSON.stringify({
        phase: "retrieval",
        repeat: repeat + 1,
        repeats: params.repeats,
        cases: jobs.length,
      }),
    );
  }
  const queue = shuffled(jobs, rng);
  let completed = 0;
  const worker = async () => {
    while (queue.length) {
      const job = queue.shift()!;
      const filename = path.join(output, "rows", `${job.key}.json`);
      if (fs.existsSync(filename)) {
        completed++;
        continue;
      }
      const row: Evaluation = {
        id: job.question.id,
        space: job.question.space,
        category: job.question.category,
        split: job.question.split,
        mode: job.mode,
        unanswerable: job.question.unanswerable ?? false,
        status: "error",
      };
      try {
        const attempts = samples[job.key];
        if (attempts.some((a) => a.error || !a.retrieval))
          throw new Error(
            "A retrieval repeat failed; inspect private retrieval journal",
          );
        const retrieval = attempts[0].retrieval!;
        row.scopeLeak = attempts.some((a) =>
          scopeLeak(a.retrieval!, job.question, suite),
        );
        if (row.scopeLeak)
          throw new Error(
            "Cross-space or unowned source detected; reader and judge were not called",
          );
        const measured = job.mode !== "closed-book" && job.mode !== "oracle";
        row.unmappedHits = measured
          ? retrieval.hits.filter((h) => !h.sources.length).length
          : 0;
        if (measured) {
          row.latencyMs = attempts.map((a) => a.retrieval!.ms);
          // Missing provenance is an instrumentation gap, never a zero or a
          // fabricated corpus-recall score. Report its coverage explicitly.
          if (!row.unmappedHits)
            row.retrieval = sourceMetrics(retrieval.hits, job.question.sources);
        }
        const context = buildContext(retrieval, params.contextTokens);
        row.contextTokens = context.tokens;
        row.contextHash = hash(context.context);
        row.staleContext =
          job.question.staleTokens?.some((t) => context.context.includes(t)) ??
          false;
        writeJson(path.join(output, "traces", `${job.key}.json`), {
          query: job.question.question,
          retrieval,
          context,
        });
        const read = await chat(
          config.reader,
          READER_PROMPT,
          readerInput(job.question, context.context),
        );
        row.readerMs = read.ms;
        row.modelUsage = read.usage;
        row.answer = parseAnswer(read.value);
        row.invalidCitations = row.answer.citations.some(
          (id) => !context.sources.includes(id),
        );
        const judged = await chat(config.judge, JUDGE_PROMPT, {
          question: job.question.question,
          reference: job.question.answer,
          unanswerable: job.question.unanswerable ?? false,
          hypothesis: row.answer,
          context: context.context,
        });
        row.judgeMs = judged.ms;
        row.modelUsage.promptTokens += judged.usage.promptTokens;
        row.modelUsage.completionTokens += judged.usage.completionTokens;
        row.judgment = parseJudgment(judged.value);
        // Citation syntax is reported separately from semantic support. A
        // bracketed ID must not turn a supported answer into a retrieval miss.
        row.status = "ok";
      } catch (error) {
        row.error =
          error instanceof Error ? error.message : "Evaluation failed";
      }
      writeJson(filename, row);
      completed++;
      console.log(
        JSON.stringify({
          phase: "evaluate",
          completed,
          total: jobs.length,
          mode: row.mode,
          question: row.id,
          status: row.status,
        }),
      );
    }
  };
  await Promise.all([worker(), worker()]);
  const report: Report = {
    ...header,
    rows: jobs.map((job) =>
      readJson<Evaluation>(path.join(output, "rows", `${job.key}.json`)),
    ),
  };
  writeJson(path.join(output, "report.json"), report);
  writeJson(path.join(output, "summary.json"), summaries(report));
  console.log(
    JSON.stringify({
      phase: "complete",
      output,
      errors: report.rows.filter((r) => r.status === "error").length,
    }),
  );
  return report;
}
