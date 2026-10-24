import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryClient, normalizeHit } from "../client.ts";
import { compare } from "../compare.ts";
import { buildContext, scopeLeak } from "../context.ts";
import { aggregate, sourceMetrics } from "../metrics.ts";
import { parseAnswer, parseJudgment, readerInput } from "../prompts.ts";
import { prepare } from "../prepare.ts";
import { run } from "../runner.ts";
import {
  hash,
  secret,
  targetIdentity,
  validateSuite,
  writeJson,
} from "../util.ts";
import { FactorySupermemoryProvider } from "../memorybench-provider.ts";
import { startStack } from "../local-stack.ts";
import type { Config, Evaluation, Report, Suite } from "../types.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "recall-test-"));
afterAll(() => fs.rmSync(temporary, { recursive: true, force: true }));
const suite: Suite = {
  schema: 1,
  id: "test",
  description: "Test fixture",
  canaries: { a: "A_ONLY", b: "B_ONLY" },
  documents: [
    { id: "d1", space: "a", date: "2026-01-01", content: "The code is OAK." },
    { id: "d2", space: "b", date: "2026-01-01", content: "B_ONLY" },
  ],
  questions: [
    {
      id: "q1",
      space: "a",
      split: "holdout",
      category: "exact",
      question: "What is the code?",
      answer: "GOLD_ONLY_848",
      sources: { d1: 1 },
    },
  ],
};
const hit = (sources: string[], text = "text") => ({
  id: sources.join("-"),
  sources,
  text,
});
const row = (id: string, correct: boolean): Evaluation => ({
  id,
  space: "a",
  category: "exact",
  split: "holdout",
  mode: "hybrid",
  status: "ok",
  judgment: { correct, grounded: true, explanation: "fixture" },
});
const report = (rows: Evaluation[]): Report => ({
  schema: 1,
  createdAt: "2026-01-01",
  corpusId: "same",
  protocol: { questionIds: rows.map((r) => r.id).sort() },
  deployment: {
    image: "image",
    extractionModel: "extract",
    embeddingModel: "embed",
  },
  modes: ["hybrid"],
  rows,
});
const keyFile = path.join(temporary, "key");
fs.writeFileSync(keyFile, "test-only", { mode: 0o600 });
const config = (baseUrl: string): Config => ({
  baseUrl,
  keyFile,
  deployment: {
    image: "image",
    extractionModel: "extract",
    embeddingModel: "embed",
  },
  reader: { baseUrl, keyFile, model: "reader" },
  judge: { baseUrl, keyFile, model: "judge" },
  repeats: 1,
});

describe("corpus-ground-truth metrics", () => {
  test("missing relevant documents remain in the denominator", () => {
    const m = sourceMetrics([hit(["irrelevant"]), hit(["a"]), hit(["a"])], {
      a: 1,
      b: 1,
    });
    expect(m.recall10).toBe(0.5);
    expect(m.mrr).toBe(0.5);
    expect(m.ndcg10).toBeCloseTo(1 / Math.log2(3) / (1 + 1 / Math.log2(3)));
  });
  test("duplicate sources cannot inflate recall or graded nDCG", () => {
    const m = sourceMetrics([hit(["a", "a"]), hit(["a"]), hit(["b"])], {
      a: 3,
      b: 1,
    });
    expect(m.recall5).toBe(1);
    expect(m.ndcg10).toBe(1);
  });
  test("negatives do not become perfect recall; empty positives score zero", () => {
    expect(sourceMetrics([], {}).recall10).toBeNull();
    expect(sourceMetrics([], { a: 1 }).recall10).toBe(0);
  });
  test("duplicate text ignores whitespace but preserves case-sensitive identifiers", () => {
    const m = sourceMetrics(
      [
        hit(["a"], "CacheTTL  83"),
        hit(["b"], " CacheTTL 83 "),
        hit(["c"], "cacheTtl 83"),
      ],
      { a: 1 },
    );
    expect(m.duplicateRate).toBeCloseTo(1 / 3);
  });
  test("failed evaluation stays in the denominator and scope failures remain visible", () => {
    const summary = aggregate([
      row("a", true),
      { ...row("b", false), status: "error", scopeLeak: true },
    ]);
    expect(summary.answerAccuracy).toBe(0.5);
    expect(summary.errors).toBe(1);
    expect(summary.scopeLeaks).toBe(1);
  });
});
test("strict reader/judge contracts never turn malformed output into a score", () => {
  expect(() =>
    parseJudgment({ correct: "true", grounded: true, explanation: "yes" }),
  ).toThrow();
  expect(() => parseJudgment({ explanation: "correct" })).toThrow();
  expect(() =>
    parseAnswer({ answer: "a", abstain: false, citations: [1] }),
  ).toThrow();
  expect(
    JSON.stringify(readerInput(suite.questions[0], "context")),
  ).not.toContain("GOLD_ONLY_848");
});
test("answerable and abstention scores have separate denominators; citation syntax is separate", () => {
  const supported = { ...row("yes", true), invalidCitations: true };
  const negative = {
    ...row("unknown", true),
    unanswerable: true,
    answer: { answer: "Unknown", abstain: true, citations: [] },
  };
  const bad = { ...row("bad", false), unanswerable: true };
  const result = aggregate([supported, negative, bad]);
  expect(result.groundedAccuracy).toBe(2 / 3);
  expect(result.answerableAccuracy).toBe(1);
  expect(result.abstentionAccuracy).toBe(0.5);
  expect(result.invalidCitations).toBe(1);
});
test("isolated stack rejects database overrides before creating resources", async () => {
  const environmentFile = path.join(temporary, "bad-provider.env"),
    directory = path.join(temporary, "forbidden-stack");
  fs.writeFileSync(
    environmentFile,
    "OPENAI_MODEL=test\nOPENAI_API_KEY=test\nOPENAI_BASE_URL=http://localhost:1/v1\nFACTORY_SUPERMEMORY_DATABASE_URL=postgres://production\n",
    { mode: 0o600 },
  );
  const model = { baseUrl: "http://localhost:1/v1", keyFile, model: "test" };
  await expect(
    startStack(directory, {
      environmentFile,
      extractionModel: "test",
      reader: model,
      judge: model,
    }),
  ).rejects.toThrow("Environment must contain only");
  expect(fs.existsSync(directory)).toBe(false);
});
test("scope checks inspect source provenance and profile canaries", () => {
  expect(
    scopeLeak(
      { hits: [hit(["d2"])], profile: [], ms: 0 },
      suite.questions[0],
      suite,
    ),
  ).toBe(true);
  expect(
    scopeLeak(
      { hits: [], profile: ["B_ONLY"], ms: 0 },
      suite.questions[0],
      suite,
    ),
  ).toBe(true);
  expect(
    scopeLeak(
      { hits: [hit(["d1"])], profile: ["A_ONLY"], ms: 0 },
      suite.questions[0],
      suite,
    ),
  ).toBe(false);
});
test("context includes labels within the token cap and does not consult gold", () => {
  const built = buildContext(
    {
      hits: [hit(["d1"], "unicode 🐱 text ".repeat(1000))],
      profile: ["fact"],
      ms: 0,
    },
    100,
  );
  expect(built.tokens).toBeLessThanOrEqual(100);
  expect(built.sources).toContain("d1");
  expect(built.context).not.toContain("GOLD_ONLY_848");
});
test("document IDs resolve profile provenance without metadata", () => {
  expect(
    normalizeHit(
      { id: "m1", memory: "OAK", documents: [{ id: "server-1" }] },
      { "server-1": "d1" },
    ).sources,
  ).toEqual(["d1"]);
  expect(
    normalizeHit({ id: "m1", memory: "OAK", documents: [{ id: "foreign" }] })
      .sources,
  ).toEqual(["unknown:foreign"]);
});
test("invalid qrels and public credentials fail early", () => {
  const bad = structuredClone(suite);
  bad.questions[0].sources = { d2: 1 };
  expect(() => validateSuite(bad)).toThrow();
  fs.chmodSync(keyFile, 0o644);
  expect(() => secret(keyFile)).toThrow();
  fs.chmodSync(keyFile, 0o600);
});
test("comparison rejects missing cases, protocol drift, errors and different corpora", () => {
  const a = report([row("q1", false), row("q2", true)]),
    b = structuredClone(a);
  b.rows[0].judgment!.correct = true;
  expect(compare(a, b, "hybrid", "hybrid").groundedAccuracyDelta).toBe(0.5);
  const missing = structuredClone(b);
  missing.rows.pop();
  expect(() => compare(a, missing, "hybrid", "hybrid")).toThrow();
  const drift = structuredClone(b);
  drift.protocol.tokenizer = "other";
  expect(() => compare(a, drift, "hybrid", "hybrid")).toThrow();
  const errors = structuredClone(b);
  errors.rows[0].status = "error";
  expect(() => compare(a, errors, "hybrid", "hybrid")).toThrow();
  const corpus = structuredClone(b);
  corpus.corpusId = "other";
  expect(() => compare(a, corpus, "hybrid", "hybrid")).toThrow();
  expect(compare(a, corpus, "hybrid", "hybrid", true).samePreparedCorpus).toBe(
    false,
  );
});
test("HTTP failures with private bodies are bounded and never blindly retry writes", async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests++;
      return new Response("PRIVATE_RESPONSE", { status: 503 });
    },
  });
  try {
    await expect(
      new MemoryClient(server.url.origin, "key").request(
        "POST",
        "/v3/documents",
        {},
      ),
    ).rejects.toThrow("HTTP 503; response body withheld");
    expect(requests).toBe(1);
  } finally {
    server.stop(true);
  }
});
test("real runner transport excludes gold, retains errors and resumes without regrading", async () => {
  let modelCalls = 0,
    searchCalls = 0,
    leak = false;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, any>;
      if (new URL(request.url).pathname === "/v4/search") {
        searchCalls++;
        return Response.json({
          results: [
            {
              id: "m1",
              memory: "The code is OAK.",
              documents: [{ id: leak ? "server-2" : "server-1" }],
            },
          ],
        });
      }
      modelCalls++;
      if (body.model === "reader")
        expect(JSON.stringify(body.messages)).not.toContain("GOLD_ONLY_848");
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify(
                body.model === "reader"
                  ? { answer: "OAK", abstain: false, citations: ["d1"] }
                  : { correct: false, grounded: true, explanation: "fixture" },
              ),
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      });
    },
  });
  try {
    const c = config(server.url.origin),
      corpus = path.join(temporary, "corpus");
    fs.mkdirSync(corpus);
    writeJson(path.join(corpus, "suite.json"), suite);
    writeJson(path.join(corpus, "manifest.json"), {
      schema: 1,
      runId: "test-run",
      suiteHash: hash(suite),
      targetIdentity: targetIdentity(c),
      deployment: c.deployment,
      prepared: true,
      spaces: { a: "owned-a", b: "owned-b" },
      documents: {
        d1: { id: "server-1", customId: "custom-1", status: "done" },
        d2: { id: "server-2", customId: "custom-2", status: "done" },
      },
    });
    const output = path.join(temporary, "results");
    const r = await run(c, corpus, output, ["hybrid"]);
    expect(r.rows[0].status).toBe("ok");
    expect(r.rows[0].retrieval!.recall10).toBe(1);
    await run(c, corpus, output, ["hybrid"]);
    expect(modelCalls).toBe(2);
    expect(searchCalls).toBe(1);
    const changed = { ...c, baseUrl: "http://localhost:1" };
    await expect(prepare(changed, suite, corpus)).rejects.toThrow(
      "changed target",
    );
    leak = true;
    const bad = await run(c, corpus, path.join(temporary, "leak"), ["hybrid"]);
    expect(bad.rows[0].status).toBe("error");
    expect(bad.rows[0].scopeLeak).toBe(true);
    expect(modelCalls).toBe(2);
  } finally {
    server.stop(true);
  }
});
test("MemoryBench adapter uses v3/v4, avoids duplicate ingestion and checks cleanup ownership", async () => {
  let doc: any,
    posts = 0,
    deleted = 0;
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const route = new URL(request.url).pathname;
      paths.push(route);
      if (route === "/v4/search") return Response.json({ results: [] });
      if (request.method === "POST") {
        posts++;
        const body = (await request.json()) as object;
        doc = {
          ...body,
          id: "owned-id",
          status: "done",
          dreamingStatus: "done",
        };
        return Response.json(doc);
      }
      if (request.method === "DELETE") {
        deleted++;
        return new Response(null, { status: 204 });
      }
      return doc ? Response.json(doc) : new Response(null, { status: 404 });
    },
  });
  try {
    const provider = new FactorySupermemoryProvider();
    await provider.initialize({
      apiKey: "key",
      baseUrl: server.url.origin,
      runId: "unique-run-12345678",
    });
    const sessions = [
        { sessionId: "s1", messages: [{ role: "user", content: "OAK" }] },
      ],
      options = { containerTag: "project/a" };
    const first = await provider.ingest(sessions, options);
    await provider.awaitIndexing(first, options.containerTag);
    await provider.ingest(sessions, options);
    expect(posts).toBe(1);
    await provider.search("code?", options);
    expect(paths).toContain("/v4/search");
    doc.metadata.eval_run = "somebody-else";
    await expect(provider.clear(options.containerTag)).rejects.toThrow(
      "unowned",
    );
    expect(deleted).toBe(0);
  } finally {
    server.stop(true);
  }
});
