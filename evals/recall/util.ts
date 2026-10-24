import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Config, Suite } from "./types.ts";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const readJson = <T>(filename: string): T =>
  JSON.parse(fs.readFileSync(filename, "utf8"));
export function writeJson(filename: string, value: unknown) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, filename);
}
export function newDirectory(dir: string) {
  fs.mkdirSync(path.dirname(path.resolve(dir)), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(dir, { mode: 0o700 });
}
export function secret(filename: string) {
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.mode & 0o077)
    throw new Error("Credential file must have mode 0600 or stricter");
  const value = fs.readFileSync(filename, "utf8").trim();
  if (!value || /[\r\n]/.test(value))
    throw new Error("Invalid credential file");
  return value;
}
export function endpoint(value: string, allowRemote = false) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use an HTTP(S) endpoint without credentials, query or fragment",
    );
  if (
    !allowRemote &&
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error(
      "Benchmark targets default to loopback; remote use requires explicit allowRemote",
    );
  return value.replace(/\/$/, "");
}
export function validateSuite(suite: Suite) {
  if (
    suite.schema !== 1 ||
    !suite.id ||
    !suite.documents.length ||
    !suite.questions.length
  )
    throw new Error("Invalid or empty benchmark suite");
  const docs = new Map(suite.documents.map((d) => [d.id, d]));
  if (
    docs.size !== suite.documents.length ||
    new Set(suite.questions.map((q) => q.id)).size !== suite.questions.length
  )
    throw new Error("Duplicate benchmark IDs");
  for (const d of suite.documents) {
    if (
      !/^[a-zA-Z0-9_-]+$/.test(d.id) ||
      !d.content.trim() ||
      !d.space ||
      !Number.isFinite(Date.parse(d.date))
    )
      throw new Error("Invalid document fixture");
  }
  for (const q of suite.questions) {
    if (
      !/^[a-zA-Z0-9_-]+$/.test(q.id) ||
      !suite.documents.some((d) => d.space === q.space) ||
      !q.question.trim() ||
      !q.answer.trim() ||
      !["development", "holdout"].includes(q.split)
    )
      throw new Error("Invalid question fixture");
    if (
      q.unanswerable
        ? Object.keys(q.sources).length !== 0
        : Object.keys(q.sources).length === 0
    )
      throw new Error("Answerability and qrels disagree");
    for (const [id, grade] of Object.entries(q.sources)) {
      const doc = docs.get(id);
      if (
        !doc ||
        doc.space !== q.space ||
        doc.forget ||
        !Number.isInteger(grade) ||
        grade < 1 ||
        grade > 3
      )
        throw new Error("Invalid, forgotten or cross-space qrel");
    }
  }
}
export function targetIdentity(config: Config) {
  return hash([
    endpoint(config.baseUrl, config.allowRemote),
    secret(config.keyFile),
  ]);
}
export function settings(config: Config) {
  const result = {
    topK: config.topK ?? 10,
    threshold: config.threshold ?? 0.6,
    contextTokens: config.contextTokens ?? 2200,
    repeats: config.repeats ?? 3,
    seed: config.seed ?? 20261024,
  };
  if (
    !Number.isInteger(result.topK) ||
    result.topK < 1 ||
    result.topK > 100 ||
    !Number.isFinite(result.threshold) ||
    result.threshold < 0 ||
    result.threshold > 1 ||
    !Number.isInteger(result.contextTokens) ||
    result.contextTokens < 100 ||
    result.contextTokens > 32000 ||
    !Number.isInteger(result.repeats) ||
    result.repeats < 1 ||
    result.repeats > 10 ||
    !Number.isInteger(result.seed)
  )
    throw new Error("Invalid benchmark settings");
  return result;
}
export function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
export function shuffled<T>(items: T[], rng: () => number) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
