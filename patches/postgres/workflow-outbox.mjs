// The document and its exact workflow input commit together. The upstream
// scheduler receives a stable actor ID; recovery can find an existing actor
// rather than replaying an already-running ingestion under another ID.
import { randomUUID } from "node:crypto";
const table = "drizzle.__factory_workflow_outbox";
const ID = "sm_factory_workflow_id";
export class WorkflowOutbox {
  constructor(queue, rivet) {
    this.queue = queue;
    this.rivet = rivet;
    this.boot = randomUUID();
  }
  async init() {
    await this.queue.pool.query(`CREATE TABLE IF NOT EXISTS ${table} (
      id text PRIMARY KEY, document_id text NOT NULL UNIQUE REFERENCES public.document(id) ON DELETE CASCADE,
      owner text NOT NULL, envelope bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      available_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0
    )`);
  }
  id(params) {
    if (typeof params === "string") return params;
    const id = params?.metadata?.[ID];
    return /^factory-wf-[a-f0-9-]{36}$/.test(id || "")
      ? id
      : "factory-wf-" + randomUUID();
  }
  async stage(tx, result, input) {
    const id = "factory-wf-" + randomUUID();
    result.metadata = {
      ...(result.metadata || input.metadata || {}),
      [ID]: id,
    };
    const params = {
      ...input,
      id: result.docId,
      metadata: result.metadata,
      filepath: input.filepath || null,
      previousExtractedContent: result.existingContent || null,
    };
    const envelope = this.queue.encrypt(id, result.docId, params),
      sql = this.queue.sql;
    await tx.execute(
      sql`INSERT INTO drizzle.__factory_workflow_outbox(id,document_id,owner,envelope) VALUES (${id},${result.docId},${this.boot},${envelope}) ON CONFLICT(document_id) DO UPDATE SET id=EXCLUDED.id,owner=EXCLUDED.owner,envelope=EXCLUDED.envelope,created_at=now(),available_at=now(),attempts=0`,
    );
    await tx.execute(
      sql`UPDATE public.document SET metadata=${result.metadata} WHERE id=${result.docId}`,
    );
    return result;
  }
  async retry(input) {
    if (!input.id) return input;
    // An explicit upstream workflow retry needs a NEW actor. Persist that new
    // identity and exact original input before calling the native scheduler.
    const client = await this.queue.pool.connect();
    try {
      await client.query("BEGIN");
      const doc = (
        await client.query(
          "SELECT id FROM public.document WHERE id=$1 AND org_id=$2 FOR UPDATE",
          [input.id, input.org?.id],
        )
      ).rows[0];
      if (!doc) throw new Error("Workflow retry target is missing");
      const id = "factory-wf-" + randomUUID(),
        metadata = { ...input.metadata, [ID]: id },
        params = { ...input, metadata };
      const envelope = this.queue.encrypt(id, input.id, params);
      await client.query(
        `INSERT INTO ${table}(id,document_id,owner,envelope) VALUES ($1,$2,$3,$4) ON CONFLICT(document_id) DO UPDATE SET id=EXCLUDED.id,owner=EXCLUDED.owner,envelope=EXCLUDED.envelope,created_at=now(),available_at=now(),attempts=0`,
        [id, input.id, this.boot, envelope],
      );
      await client.query("UPDATE public.document SET metadata=$2 WHERE id=$1", [
        input.id,
        metadata,
      ]);
      await client.query("COMMIT");
      return params;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async recover() {
    if (!this.rivet || Date.now() - (this.lastScan || 0) < 1000) return;
    this.lastScan = Date.now();
    // Completed document work no longer needs a private replay payload. Preserve
    // failed work for diagnosis/retry using the upstream mechanisms.
    await this.queue.pool.query(
      `DELETE FROM ${table} o USING public.document d WHERE d.id=o.document_id AND d.status='done'`,
    );
    const rows = (
      await this.queue.pool.query(
        `SELECT o.* FROM ${table} o JOIN public.document d ON d.id=o.document_id WHERE o.owner<>$1 AND o.available_at<=now() AND d.status NOT IN ('done','failed') ORDER BY o.created_at LIMIT 2`,
        [this.boot],
      )
    ).rows;
    for (const row of rows) {
      if (this.queue.halted) break;
      let state;
      try {
        state = await this.rivet(row.id);
      } catch (error) {
        // Only an authoritative not-found permits creation. An unavailable
        // engine must never be mistaken for a missing actor.
        const status =
          error?.statusCode ?? error?.status ?? error?.response?.status;
        const missingActor =
          error?.__type === "RivetError" &&
          error?.group === "actor" &&
          error?.code === "not_found";
        if (!missingActor) {
          this.queue.log(
            `[factory-postgres] workflow state unavailable (${typeof status === "number" ? status : "unknown"})`,
          );
          await this.defer(row);
          continue;
        }
      }
      if (state) {
        await this.queue.pool.query(
          `UPDATE ${table} SET owner=$2 WHERE id=$1`,
          [row.id, this.boot],
        );
        continue;
      }
      const params = this.queue.decrypt(row);
      await this.rivet(row.id, params);
      await this.defer(row);
      this.queue.log("[factory-postgres] recovered committed workflow handoff");
    }
  }
  async defer(row) {
    await this.queue.pool.query(
      `UPDATE ${table} SET attempts=attempts+1,available_at=now()+interval '5 seconds' WHERE id=$1`,
      [row.id],
    );
  }
}
