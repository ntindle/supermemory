import { endpoint } from "./util.ts";
import type { Hit, Mode, Retrieval } from "./types.ts";

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Unexpected API object shape");
  return value as Record<string, unknown>;
}
export function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    throw new Error("Unexpected API string-array shape");
  return value;
}
export class MemoryHttpError extends Error {
  constructor(readonly status: number) {
    super(`Memory API HTTP ${status}; response body withheld`);
  }
}
export class MemoryClient {
  readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private key: string,
    allowRemote = false,
    private timeoutMs = 15000,
    private documentIds: Record<string, string> = {},
  ) {
    this.baseUrl = endpoint(baseUrl, allowRemote);
  }
  async request(
    method: string,
    route: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(this.baseUrl + route, {
        method,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new Error("Memory API transport failed; request was not retried");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new MemoryHttpError(response.status);
    }
    if (response.status === 204) return {};
    try {
      return record(await response.json());
    } catch {
      throw new Error("Memory API returned invalid JSON/shape");
    }
  }
  async waitForDocument(id: string, timeoutMs = 300000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const document = await this.request(
        "GET",
        `/v3/documents/${encodeURIComponent(id)}`,
      );
      if (
        [document.status, document.dreamingStatus].some(
          (s) => s === "failed" || s === "error",
        )
      )
        throw new Error("Benchmark document ingestion failed");
      if (
        document.status === "done" &&
        (!document.dreamingStatus || document.dreamingStatus === "done")
      )
        return document;
      await Bun.sleep(500);
    }
    throw new Error("Benchmark document indexing deadline exceeded");
  }
  async removeOwnedDocument(id: string, runId: string) {
    const doc = await this.request(
      "GET",
      `/v3/documents/${encodeURIComponent(id)}`,
    );
    if (record(doc.metadata).eval_run !== runId)
      throw new Error(
        "Refusing to remove a document not owned by this benchmark run",
      );
    await this.request("DELETE", `/v3/documents/${encodeURIComponent(id)}`);
  }
  async retrieve(
    query: string,
    tag: string,
    mode: Exclude<Mode, "oracle" | "closed-book">,
    topK: number,
    threshold: number,
  ): Promise<Retrieval> {
    const started = performance.now();
    let raw: unknown[],
      profile: string[] = [];
    if (mode === "profile") {
      const result = await this.request("POST", "/v4/profile", {
        containerTag: tag,
        q: query,
        threshold,
      });
      const standing = record(result.profile);
      profile = [...strings(standing.static), ...strings(standing.dynamic)];
      raw = record(result.searchResults).results as unknown[];
    } else {
      const result = await this.request("POST", "/v4/search", {
        containerTag: tag,
        q: query,
        limit: topK,
        threshold,
        searchMode: mode,
        include: { documents: true },
        rerank: false,
        rewriteQuery: false,
      });
      raw = result.results as unknown[];
    }
    if (!Array.isArray(raw))
      throw new Error("Memory API omitted search results");
    const hits = raw
      .slice(0, topK)
      .map((hit) => normalizeHit(hit, this.documentIds));
    return { hits, profile, ms: performance.now() - started };
  }
}
export function normalizeHit(
  value: unknown,
  documentIds: Record<string, string> = {},
): Hit {
  const hit = record(value);
  const text = typeof hit.memory === "string" ? hit.memory : hit.chunk;
  if (typeof hit.id !== "string" || typeof text !== "string")
    throw new Error("Unsupported memory/chunk result shape");
  const sources: string[] = [];
  const metadata = (item: Record<string, unknown>) => {
    if (item.metadata && typeof item.metadata === "object") {
      const id = record(item.metadata).eval_document_id;
      if (typeof id === "string") sources.push(id);
    }
  };
  metadata(hit);
  if (Array.isArray(hit.documents))
    for (const value of hit.documents) {
      const doc = record(value);
      metadata(doc);
      if (typeof doc.id === "string")
        sources.push(documentIds[doc.id] ?? `unknown:${doc.id}`);
    }
  return { id: hit.id, text, sources: [...new Set(sources)] };
}
