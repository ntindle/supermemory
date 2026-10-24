export interface Document {
  id: string;
  space: string;
  date: string;
  content: string;
  forget?: boolean;
}
export interface Question {
  id: string;
  space: string;
  category: string;
  split: "development" | "holdout";
  question: string;
  answer: string;
  sources: Record<string, number>;
  unanswerable?: boolean;
  staleTokens?: string[];
}
export interface Suite {
  schema: 1;
  id: string;
  description: string;
  documents: Document[];
  questions: Question[];
  canaries: Record<string, string>;
}
export interface Hit {
  id: string;
  text: string;
  sources: string[];
}
export type Mode = "profile" | "memories" | "hybrid" | "closed-book" | "oracle";
export interface ModelConfig {
  baseUrl: string;
  keyFile: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
}
export interface Config {
  baseUrl: string;
  keyFile: string;
  allowRemote?: boolean;
  deployment: {
    image: string;
    extractionModel: string;
    embeddingModel: string;
  };
  reader: ModelConfig;
  judge: ModelConfig;
  suite?: string;
  topK?: number;
  threshold?: number;
  contextTokens?: number;
  repeats?: number;
  seed?: number;
}
export interface Manifest {
  schema: 1;
  runId: string;
  suiteHash: string;
  targetIdentity: string;
  documents: Record<string, { id: string; customId: string; status: string }>;
  spaces: Record<string, string>;
  prepared: boolean;
  preparedAt?: string;
  deployment: Config["deployment"];
}
export interface Retrieval {
  hits: Hit[];
  profile: string[];
  ms: number;
}
export interface Answer {
  answer: string;
  abstain: boolean;
  citations: string[];
}
export interface Judgment {
  correct: boolean;
  grounded: boolean;
  explanation: string;
}
export interface SourceMetrics {
  recall5: number | null;
  recall10: number | null;
  mrr: number | null;
  ndcg10: number | null;
  duplicateRate: number;
}
export interface Evaluation {
  id: string;
  space: string;
  category: string;
  split: Question["split"];
  mode: Mode;
  status: "ok" | "error";
  error?: string;
  retrieval?: SourceMetrics;
  latencyMs?: number[];
  contextTokens?: number;
  contextHash?: string;
  scopeLeak?: boolean;
  unmappedHits?: number;
  invalidCitations?: boolean;
  unanswerable?: boolean;
  staleContext?: boolean;
  answer?: Answer;
  judgment?: Judgment;
  readerMs?: number;
  judgeMs?: number;
  modelUsage?: { promptTokens: number; completionTokens: number };
}
export interface Report {
  schema: 1;
  createdAt: string;
  protocol: Record<string, unknown>;
  corpusId: string;
  deployment: Config["deployment"];
  modes: Mode[];
  runtime?: { bun: string; platform: string; arch: string };
  rows: Evaluation[];
}
