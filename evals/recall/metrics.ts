import type { Evaluation, Hit, SourceMetrics } from "./types.ts";
export const normalizedText = (text: string) =>
  text.normalize("NFC").trim().replace(/\s+/g, " ");
export const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
export function percentile(xs: number[], p: number) {
  if (!xs.length) return null;
  return [...xs].sort((a, b) => a - b)[
    Math.max(0, Math.ceil(p * xs.length) - 1)
  ];
}
// Source-document ranks, projected from API hit/provenance order. Each source
// contributes once. This measures source retrieval, not factual correctness.
export function sourceMetrics(
  hits: Hit[],
  qrels: Record<string, number>,
): SourceMetrics {
  const ranking = [...new Set(hits.flatMap((h) => h.sources))];
  const gold = Object.keys(qrels);
  const dcg = (grades: number[]) =>
    grades.reduce(
      (sum, grade, i) => sum + (2 ** grade - 1) / Math.log2(i + 2),
      0,
    );
  const ideal = dcg(
    Object.values(qrels)
      .sort((a, b) => b - a)
      .slice(0, 10),
  );
  const first = ranking.findIndex((id) => qrels[id] > 0);
  return {
    recall5: gold.length
      ? ranking.slice(0, 5).filter((id) => qrels[id] > 0).length / gold.length
      : null,
    recall10: gold.length
      ? ranking.slice(0, 10).filter((id) => qrels[id] > 0).length / gold.length
      : null,
    mrr: gold.length ? (first < 0 ? 0 : 1 / (first + 1)) : null,
    ndcg10: ideal
      ? dcg(ranking.slice(0, 10).map((id) => qrels[id] || 0)) / ideal
      : null,
    duplicateRate: hits.length
      ? 1 - new Set(hits.map((h) => normalizedText(h.text))).size / hits.length
      : 0,
  };
}
export function aggregate(rows: Evaluation[]) {
  const ok = rows.filter((r) => r.status === "ok");
  const metric = (key: keyof SourceMetrics) =>
    mean(
      ok.flatMap((r) =>
        typeof r.retrieval?.[key] === "number"
          ? [r.retrieval[key] as number]
          : [],
      ),
    );
  const latency = ok.flatMap((r) => r.latencyMs ?? []);
  return {
    questions: rows.length,
    completed: ok.length,
    errors: rows.length - ok.length,
    // Errors stay in the denominator; a broken judge cannot improve accuracy.
    answerAccuracy: rows.length
      ? ok.filter((r) => r.judgment?.correct).length / rows.length
      : null,
    groundedAccuracy: rows.length
      ? ok.filter((r) => r.judgment?.correct && r.judgment.grounded).length /
        rows.length
      : null,
    answerableQuestions: rows.filter((r) => !r.unanswerable).length,
    answerableAccuracy: mean(
      rows
        .filter((r) => !r.unanswerable)
        .map((r) =>
          Number(
            r.status === "ok" && r.judgment?.correct && r.judgment.grounded,
          ),
        ),
    ),
    unanswerableQuestions: rows.filter((r) => r.unanswerable).length,
    abstentionAccuracy: mean(
      rows
        .filter((r) => r.unanswerable)
        .map((r) =>
          Number(r.status === "ok" && r.judgment?.correct && r.answer?.abstain),
        ),
    ),
    sourceScoredQuestions: ok.filter(
      (r) =>
        r.retrieval?.recall10 !== null && r.retrieval?.recall10 !== undefined,
    ).length,
    sourceRecall5: metric("recall5"),
    sourceRecall10: metric("recall10"),
    sourceMRR: metric("mrr"),
    sourceNDCG10: metric("ndcg10"),
    duplicateRate: metric("duplicateRate"),
    scopeLeaks: rows.filter((r) => r.scopeLeak).length,
    unmappedHits: rows.reduce((n, r) => n + (r.unmappedHits ?? 0), 0),
    invalidCitations: rows.filter((r) => r.invalidCitations).length,
    staleContextRate: ok.length
      ? ok.filter((r) => r.staleContext).length / ok.length
      : null,
    contextTokensMean: mean(
      ok.flatMap((r) =>
        r.contextTokens === undefined ? [] : [r.contextTokens],
      ),
    ),
    retrievalP50Ms: percentile(latency, 0.5),
    retrievalP95Ms: percentile(latency, 0.95),
    retrievalOver3000Ms: latency.filter((n) => n > 3000).length,
    modelPromptTokens: ok.reduce(
      (n, r) => n + (r.modelUsage?.promptTokens ?? 0),
      0,
    ),
    modelCompletionTokens: ok.reduce(
      (n, r) => n + (r.modelUsage?.completionTokens ?? 0),
      0,
    ),
  };
}
