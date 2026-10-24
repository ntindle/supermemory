import { getEncoding } from "js-tiktoken";
import type { Question, Retrieval, Suite } from "./types.ts";

const encoder = getEncoding("cl100k_base");
export function scopeLeak(
  retrieval: Retrieval,
  question: Question,
  suite: Suite,
) {
  const owned = new Set(
    suite.documents.filter((d) => d.space === question.space).map((d) => d.id),
  );
  const text = [
    ...retrieval.profile,
    ...retrieval.hits.map((h) => h.text),
  ].join("\n");
  return (
    retrieval.hits.some((h) => h.sources.some((id) => !owned.has(id))) ||
    Object.entries(suite.canaries).some(
      ([space, canary]) => space !== question.space && text.includes(canary),
    )
  );
}

// Greedy API order, without consulting qrels. The complete rendered string,
// including source labels, must fit the budget. cl100k_base is a budgeting
// tokenizer, not a claim about a proprietary model's actual token usage.
export function buildContext(retrieval: Retrieval, budget: number) {
  const entries = [
    ...retrieval.profile.map((text) => ({ sources: ["profile"], text })),
    ...retrieval.hits.map((h) => ({
      sources: h.sources.length ? h.sources : [h.id],
      text: h.text,
    })),
  ];
  let context = "";
  const sources = new Set<string>();
  for (const entry of entries) {
    const prefix = `${context ? "\n\n" : ""}[${entry.sources.join(", ")}] `;
    const tokens = encoder.encode(entry.text);
    let lo = 0,
      hi = tokens.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (
        encoder.encode(context + prefix + encoder.decode(tokens.slice(0, mid)))
          .length <= budget
      )
        lo = mid;
      else hi = mid - 1;
    }
    if (!lo) break;
    context += prefix + encoder.decode(tokens.slice(0, lo));
    entry.sources.forEach((id) => sources.add(id));
    if (lo < tokens.length) break;
  }
  return {
    context,
    sources: [...sources],
    tokens: encoder.encode(context).length,
  };
}
