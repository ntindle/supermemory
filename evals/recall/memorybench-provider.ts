// Structurally compatible with supermemoryai/memorybench Provider at
// 063b86bfb347336def3a084153f40bfea1e2dfd6. No v5 or cloud-only dependency.
import { MemoryClient, MemoryHttpError, record } from "./client.ts";
import { hash } from "./util.ts";

interface Session {
  sessionId: string;
  messages: {
    role: string;
    content: string;
    speaker?: string;
    timestamp?: string;
  }[];
  metadata?: Record<string, unknown>;
}
interface IngestOptions {
  containerTag: string;
  metadata?: Record<string, unknown>;
}
interface SearchOptions {
  containerTag: string;
  limit?: number;
  threshold?: number;
}
interface IngestResult {
  documentIds: string[];
  taskIds?: string[];
}
type Progress = (value: {
  completedIds: string[];
  failedIds: string[];
  total: number;
}) => void;

export class FactorySupermemoryProvider {
  name = "supermemory";
  concurrency = { default: 2, ingest: 1, indexing: 2, search: 1 };
  private client!: MemoryClient;
  private runId = "";
  private mode: "hybrid" | "memories" = "hybrid";
  private owned = new Map<string, Set<string>>();
  async initialize(config: {
    apiKey: string;
    baseUrl?: string;
    [key: string]: unknown;
  }) {
    if (
      Object.keys(config).some(
        (key) =>
          !["apiKey", "baseUrl", "runId", "searchMode", "allowRemote"].includes(
            key,
          ),
      )
    )
      throw new Error("Unsupported MemoryBench adapter setting");
    if (
      !config.apiKey ||
      !config.baseUrl ||
      typeof config.runId !== "string" ||
      !/^[a-zA-Z0-9_-]{16,64}$/.test(config.runId)
    )
      throw new Error(
        "MemoryBench adapter requires apiKey, baseUrl and a unique runId (16-64 safe characters)",
      );
    if (
      config.searchMode !== undefined &&
      !["hybrid", "memories"].includes(String(config.searchMode))
    )
      throw new Error("Adapter supports hybrid or memories search");
    this.runId = config.runId;
    this.mode = config.searchMode === "memories" ? "memories" : "hybrid";
    this.client = new MemoryClient(
      config.baseUrl,
      config.apiKey,
      config.allowRemote === true,
    );
  }
  private tag(containerTag: string) {
    return `mb_${hash([this.runId, containerTag]).slice(0, 48)}`;
  }
  async ingest(
    sessions: Session[],
    options: IngestOptions,
  ): Promise<IngestResult> {
    const tag = this.tag(options.containerTag),
      documentIds: string[] = [];
    const owned = this.owned.get(tag) ?? new Set<string>();
    this.owned.set(tag, owned);
    for (const session of sessions) {
      const content =
        (session.metadata?.formattedDate
          ? `Session date: ${session.metadata.formattedDate}\n\n`
          : "") +
        session.messages
          .map((m) => `${m.speaker || m.role}: ${m.content}`)
          .join("\n");
      const customId = `mb_${hash([this.runId, options.containerTag, session.sessionId])}`;
      let existing: Record<string, unknown> | undefined;
      try {
        existing = await this.client.request(
          "GET",
          `/v3/documents/${customId}`,
        );
      } catch (error) {
        if (!(error instanceof MemoryHttpError) || error.status !== 404)
          throw error;
      }
      if (
        existing &&
        (record(existing.metadata).eval_run !== this.runId ||
          record(existing.metadata).eval_content_hash !== hash(content) ||
          record(existing.metadata).eval_space !== tag)
      )
        throw new Error("Existing adapter document does not match this run");
      const response =
        existing ??
        (await this.client.request("POST", "/v3/documents", {
          content,
          customId,
          containerTag: tag,
          ...(typeof session.metadata?.date === "string"
            ? { documentDate: session.metadata.date }
            : {}),
          metadata: {
            eval_run: this.runId,
            eval_space: tag,
            eval_document_id: session.sessionId,
            eval_content_hash: hash(content),
          },
        }));
      if (typeof response.id !== "string")
        throw new Error("MemoryBench ingest response omitted document ID");
      documentIds.push(response.id);
      owned.add(response.id);
      // Maintain input chronology, including memory extraction, within a space.
      await this.client.waitForDocument(response.id);
    }
    return { documentIds };
  }
  async awaitIndexing(
    result: IngestResult,
    containerTag: string,
    onProgress?: Progress,
  ) {
    const completedIds: string[] = [],
      failedIds: string[] = [];
    for (const id of result.documentIds) {
      try {
        const document = await this.client.waitForDocument(id);
        if (
          record(document.metadata).eval_run !== this.runId ||
          record(document.metadata).eval_space !== this.tag(containerTag)
        )
          throw new Error("Unowned document in adapter indexing result");
        completedIds.push(id);
      } catch (error) {
        failedIds.push(id);
        onProgress?.({
          completedIds,
          failedIds,
          total: result.documentIds.length,
        });
        throw error;
      }
      onProgress?.({
        completedIds: [...completedIds],
        failedIds: [],
        total: result.documentIds.length,
      });
    }
  }
  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const response = await this.client.request("POST", "/v4/search", {
      containerTag: this.tag(options.containerTag),
      q: query,
      searchMode: this.mode,
      limit: options.limit ?? 10,
      threshold: options.threshold ?? 0.6,
      include: { documents: true },
      rerank: false,
      rewriteQuery: false,
    });
    if (!Array.isArray(response.results))
      throw new Error("MemoryBench search response omitted results");
    return response.results;
  }
  async clear(containerTag: string) {
    const tag = this.tag(containerTag);
    for (const id of this.owned.get(tag) ?? []) {
      const doc = await this.client.request(
        "GET",
        `/v3/documents/${encodeURIComponent(id)}`,
      );
      if (
        record(doc.metadata).eval_run !== this.runId ||
        record(doc.metadata).eval_space !== tag
      )
        throw new Error("Refusing adapter cleanup of an unowned document");
      await this.client.removeOwnedDocument(id, this.runId);
      this.owned.get(tag)!.delete(id);
    }
  }
}
