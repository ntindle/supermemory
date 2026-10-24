import { aggregate, mean, percentile } from "./metrics.ts";
import { hash, random } from "./util.ts";
import type { Evaluation, Mode, Report } from "./types.ts";

export function assertComparable(
  base: Report,
  candidate: Report,
  allowDifferentCorpus = false,
) {
  if (
    base.schema !== 1 ||
    candidate.schema !== 1 ||
    hash(base.protocol) !== hash(candidate.protocol)
  )
    throw new Error(
      "Incompatible evaluation protocols, datasets or model settings",
    );
  if (!allowDifferentCorpus && base.corpusId !== candidate.corpusId)
    throw new Error(
      "Retrieval comparison requires the same prepared corpus; explicitly allow different corpus for ingestion/deployment comparisons",
    );
  for (const report of [base, candidate]) {
    if (
      report.rows.some(
        (r) =>
          typeof r.judgment?.correct !== "boolean" ||
          typeof r.judgment?.grounded !== "boolean",
      )
    )
      throw new Error("Missing or malformed judgment");
    if (!report.rows.length || report.rows.some((r) => r.status !== "ok"))
      throw new Error(
        "Incomplete evaluation: fix errors and rerun before comparing",
      );
    if (report.rows.some((r) => r.scopeLeak))
      throw new Error("Scope isolation failed; quality comparison refused");
    if (
      new Set(report.rows.map((r) => `${r.mode}/${r.id}`)).size !==
      report.rows.length
    )
      throw new Error("Duplicate evaluation rows");
    if (
      !Array.isArray(report.protocol.questionIds) ||
      !report.modes.length ||
      new Set(report.modes).size !== report.modes.length ||
      report.rows.some((r) => !report.modes.includes(r.mode))
    )
      throw new Error("Invalid report mode/question manifest");
    for (const mode of report.modes)
      if (
        hash(
          report.rows
            .filter((r) => r.mode === mode)
            .map((r) => r.id)
            .sort(),
        ) !== hash(report.protocol.questionIds)
      )
        throw new Error("Missing or unexpected question rows");
  }
}
export function compare(
  base: Report,
  candidate: Report,
  baseMode: Mode,
  candidateMode: Mode,
  allowDifferentCorpus = false,
) {
  assertComparable(base, candidate, allowDifferentCorpus);
  const a = base.rows
    .filter((r) => r.mode === baseMode)
    .sort((a, b) => a.id.localeCompare(b.id));
  const b = candidate.rows
    .filter((r) => r.mode === candidateMode)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (
    !a.length ||
    hash(a.map((r) => [r.id, r.space, r.category, r.split])) !==
      hash(b.map((r) => [r.id, r.space, r.category, r.split]))
  )
    throw new Error("Question sets or splits do not match");
  const score = (r: Evaluation) =>
    Number(r.judgment?.correct && r.judgment.grounded);
  const differences = a.map((r, i) => ({
    space: r.space,
    delta: score(b[i]) - score(r),
  }));
  const spaces = [...new Set(differences.map((d) => d.space))];
  const rng = random(20261024),
    distribution: number[] = [];
  // Resample entire memory spaces: questions sharing a corpus are correlated.
  for (let trial = 0; trial < 5000; trial++) {
    const sample = spaces.flatMap(() => {
      const selected = spaces[Math.floor(rng() * spaces.length)];
      return differences
        .filter((d) => d.space === selected)
        .map((d) => d.delta);
    });
    distribution.push(mean(sample)!);
  }
  return {
    baseMode,
    candidateMode,
    samePreparedCorpus: base.corpusId === candidate.corpusId,
    questions: a.length,
    independentSpaces: spaces.length,
    baseline: aggregate(a),
    candidate: aggregate(b),
    groundedAccuracyDelta: mean(differences.map((d) => d.delta)),
    clusterBootstrap95: [
      percentile(distribution, 0.025),
      percentile(distribution, 0.975),
    ],
    improved: a.filter((r, i) => score(b[i]) > score(r)).map((r) => r.id),
    regressed: a.filter((r, i) => score(b[i]) < score(r)).map((r) => r.id),
    limitation:
      "Small synthetic regression suite; cluster intervals are descriptive, not evidence of general memory-system superiority. Holdout cases are public and must not be tuned against.",
  };
}
