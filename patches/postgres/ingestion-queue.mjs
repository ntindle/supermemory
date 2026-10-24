// Preserve text captures that upstream 0.0.8 silently skips while their document
// is processing. The hook runs inside the upstream, already-authorized database
// transaction. Deferred requests remain encrypted until accepted by that same API.
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WorkflowOutbox } from "./workflow-outbox.mjs";

const ID = "sm_factory_delivery_id",
  PROOF = "sm_factory_delivery_proof";
const ready = (status) => status === "done" || status === "failed";
const table = "drizzle.__factory_ingest_queue";
const canonical = (value) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );

export class IngestionQueue {
  constructor({
    pool,
    sql,
    key,
    dir,
    track = new Set(),
    log = console.info,
    pollMs = 250,
    concurrency = 2,
    rivet,
  }) {
    this.pool = pool;
    this.sql = sql;
    this.dir = dir;
    this.track = track;
    this.log = log;
    this.key = createHmac("sha256", key)
      .update("factory-postgres-ingest-queue-v1")
      .digest();
    this.pollMs = pollMs;
    this.concurrency = concurrency;
    this.active = new Map();
    this.halted = false;
    this.scanning = false;
    this.workflows = new WorkflowOutbox(this, rivet);
  }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${table} (
      id text PRIMARY KEY, sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      org_id text NOT NULL, document_id text NOT NULL REFERENCES public.document(id) ON DELETE CASCADE, custom_id text NOT NULL,
      request_hash text NOT NULL, envelope bytea,
      state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','failed','done')),
      attempts integer NOT NULL DEFAULT 0, last_error text,
      available_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS factory_ingest_pending_hash ON ${table}(document_id,request_hash) WHERE state='pending';
    CREATE INDEX IF NOT EXISTS factory_ingest_pending_order ON ${table}(document_id,sequence) WHERE state IN ('pending','failed');`);
    // Upgrade candidates made before the deletion check was added. A forgotten
    // document must also remove its deferred content in the same transaction.
    await this.pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='${table}'::regclass AND contype='f') THEN
        ALTER TABLE ${table} ADD CONSTRAINT factory_ingest_document_fk FOREIGN KEY(document_id) REFERENCES public.document(id) ON DELETE CASCADE;
      END IF;
    END $$`);
    await this.workflows.init();
    this.timer = setInterval(() => {
      void this.tick().catch(() =>
        this.log("[factory-postgres] capture queue scan failed"),
      );
    }, this.pollMs);
    this.timer.unref();
    return this;
  }
  proof(id, docId) {
    return createHmac("sha256", this.key)
      .update(JSON.stringify([id, docId]))
      .digest("hex");
  }
  validProof(metadata, docId) {
    if (
      typeof metadata?.[ID] !== "string" ||
      !/^[a-f0-9]{64}$/.test(metadata?.[PROOF] || "")
    )
      return false;
    return timingSafeEqual(
      Buffer.from(metadata[PROOF], "hex"),
      Buffer.from(this.proof(metadata[ID], docId), "hex"),
    );
  }
  encrypt(id, documentId, payload) {
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([id, documentId])));
    return Buffer.concat([
      nonce,
      cipher.update(JSON.stringify(payload)),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
  }
  decrypt(row) {
    const bytes = Buffer.from(row.envelope),
      decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        bytes.subarray(0, 12),
      );
    decipher.setAAD(Buffer.from(JSON.stringify([row.id, row.document_id])));
    decipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(12, -16)),
        decipher.final(),
      ]).toString(),
    );
  }
  async lock(tx, orgId, customId) {
    await tx.execute(
      this
        .sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([orgId, customId])}, 0))`,
    );
  }
  missing(metadata) {
    // A queued delivery cannot turn into a new document if DELETE won the race.
    if (metadata?.[ID] || metadata?.[PROOF])
      throw new Error("Deferred capture target was deleted");
    return { action: "continue" };
  }
  wid(params) {
    return this.workflows.id(params);
  }
  stage(tx, result, params) {
    return this.workflows.stage(tx, result, params);
  }
  retry(params) {
    return this.workflows.retry(params);
  }
  async capture(
    tx,
    document,
    customId,
    orgId,
    tags,
    content,
    metadata,
    input = {},
  ) {
    const pending = (
      await tx.execute(
        this
          .sql`SELECT id,state FROM drizzle.__factory_ingest_queue WHERE document_id=${document.id} AND state IN ('pending','failed') ORDER BY sequence LIMIT 1`,
      )
    ).rows[0];
    if (
      document.status === "failed" &&
      (
        await tx.execute(
          this
            .sql`SELECT id FROM drizzle.__factory_workflow_outbox WHERE document_id=${document.id}`,
        )
      ).rows.length
    )
      throw new Error("Previous ingestion failed; retry it before appending");
    const delivery =
      this.validProof(metadata, document.id) && metadata[ID] === pending?.id;
    if (delivery) {
      if (!ready(document.status))
        return { action: "skip", docId: document.id, status: document.status };
      // Upstream may deduplicate identical content without writing metadata.
      // Record acceptance inside this transaction so that successful no-op does
      // not leave a durable queue entry waiting forever for a receipt.
      if (
        document.status === "done" &&
        content &&
        document.content === content
      ) {
        const receipt = {
          ...document.metadata,
          [ID]: metadata[ID],
          [PROOF]: metadata[PROOF],
        };
        await tx.execute(
          this
            .sql`UPDATE public.document SET metadata=${receipt} WHERE id=${document.id}`,
        );
      }
      return null;
    }
    // These fields belong to the delivery protocol, not caller-supplied metadata.
    if (metadata) {
      delete metadata[ID];
      delete metadata[PROOF];
    }
    if (ready(document.status) && !pending) return null;
    if (input.__factoryIsReplace)
      throw new Error(
        "Document is busy; retry replacement after ingestion completes",
      );
    // This compatibility fix targets text captures. Other input types keep the
    // upstream busy behavior; do not reinterpret URL/file ingestion as plain text.
    if (typeof content !== "string" || /^https?:\/\//i.test(content.trim()))
      return { action: "skip", docId: document.id, status: document.status };
    if (pending?.state === "failed")
      throw new Error(
        "A saved document update requires operator retry; new capture was not accepted",
      );
    const count = (
      await tx.execute(
        this
          .sql`SELECT count(*)::int AS count FROM drizzle.__factory_ingest_queue WHERE document_id=${document.id} AND state='pending'`,
      )
    ).rows[0].count;
    if (count >= 256)
      throw new Error("Document capture queue is full; retry later");
    const payload = {
      ...input,
      customId,
      ...(tags.length === 1
        ? { containerTag: tags[0] }
        : { containerTags: tags }),
      content,
      metadata: metadata || {},
    };
    delete payload.__factoryIsReplace;
    const hash = createHash("sha256").update(canonical(payload)).digest("hex"),
      id = randomUUID();
    const envelope = this.encrypt(id, document.id, payload);
    await tx.execute(
      this
        .sql`INSERT INTO drizzle.__factory_ingest_queue (id,org_id,document_id,custom_id,request_hash,envelope) VALUES (${id},${orgId},${document.id},${customId},${hash},${envelope}) ON CONFLICT DO NOTHING`,
    );
    return { action: "skip", docId: document.id, status: "deferred" };
  }
  bind(app, env) {
    this.app = app;
    this.env = env;
  }
  async fetch(request, env, app) {
    this.bind(app, env);
    const response = await app.fetch(request, env);
    if (
      request.method !== "GET" ||
      !/^\/v3\/documents\/[^/]+$/.test(new URL(request.url).pathname) ||
      !response.ok
    )
      return response;
    const data = await response
      .clone()
      .json()
      .catch(() => null);
    if (!data?.id || !data?.status) return response;
    const pending = (
      await this.pool.query(
        `SELECT state FROM ${table} WHERE document_id=$1 AND state IN ('pending','failed') ORDER BY sequence LIMIT 1`,
        [data.id],
      )
    ).rows[0];
    if (!pending) return response;
    data.status = pending.state === "failed" ? "failed" : "queued";
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return Response.json(data, { status: response.status, headers });
  }
  async complete(row) {
    await this.pool.query(
      `UPDATE ${table} SET state='done',envelope=NULL,completed_at=now(),last_error=NULL WHERE id=$1`,
      [row.id],
    );
  }
  async deliver(row) {
    const document = (
      await this.pool.query(
        "SELECT status,metadata FROM public.document WHERE id=$1 AND org_id=$2",
        [row.document_id, row.org_id],
      )
    ).rows[0];
    if (!document) return this.fail(row, "source_document_missing", true);
    // The API writes this receipt in the same transaction as its document update.
    // A crash after acceptance but before queue acknowledgement must not replay it.
    if (
      document.metadata?.[ID] === row.id &&
      this.validProof(document.metadata, row.document_id)
    )
      return this.complete(row);
    if (!ready(document.status)) return;
    let payload;
    try {
      payload = this.decrypt(row);
    } catch {
      return this.fail(row, "decryption_failed", true);
    }
    payload.metadata = {
      ...payload.metadata,
      [ID]: row.id,
      [PROOF]: this.proof(row.id, row.document_id),
    };
    const key = fs.readFileSync(path.join(this.dir, "api-key"), "utf8").trim();
    const headers = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Host: "factory-supermemory.internal",
    };
    const session = await this.app.fetch(
      new Request("http://factory-supermemory.internal/v3/session", {
        headers,
      }),
      this.env,
    );
    const identity = await session.json().catch(() => null);
    if (!session.ok || identity?.org?.id !== row.org_id)
      return this.fail(row, "service_identity_rejected", true);
    const response = await this.app.fetch(
      new Request("http://factory-supermemory.internal/v3/documents", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      }),
      this.env,
    );
    await response.arrayBuffer();
    const after = (
      await this.pool.query(
        "SELECT metadata FROM public.document WHERE id=$1 AND org_id=$2",
        [row.document_id, row.org_id],
      )
    ).rows[0];
    if (
      after?.metadata?.[ID] === row.id &&
      this.validProof(after.metadata, row.document_id)
    )
      return this.complete(row);
    if (!response.ok)
      return this.fail(
        row,
        `delivery_http_${response.status}`,
        response.status >= 400 && response.status < 500,
      );
    // A concurrent workflow can still be busy when the validated API runs.
    // Retain the row and retry; a 2xx response alone is not proof of delivery.
  }
  async fail(row, code, permanent = false) {
    await this.pool.query(
      `UPDATE ${table} SET attempts=attempts+1,last_error=$2,state=CASE WHEN $3 OR attempts>=4 THEN 'failed' ELSE 'pending' END,available_at=now()+interval '5 seconds' WHERE id=$1`,
      [row.id, code, permanent],
    );
    this.log(
      `[factory-postgres] saved capture could not be delivered (${code}); payload retained`,
    );
  }
  tick() {
    if (this.scan) return this.scan;
    this.scan = this.scanOnce().finally(() => {
      this.scan = null;
    });
    return this.scan;
  }
  async scanOnce() {
    if (
      this.halted ||
      !this.app ||
      this.scanning ||
      this.active.size >= this.concurrency
    )
      return;
    this.scanning = true;
    try {
      await this.workflows.recover();
      const rows = (
        await this.pool.query(
          `SELECT first.* FROM (SELECT DISTINCT ON (document_id) * FROM ${table} WHERE state IN ('pending','failed') ORDER BY document_id,sequence) first JOIN public.document d ON d.id=first.document_id WHERE first.state='pending' AND first.available_at<=now() AND (d.status IN ('done','failed') OR d.metadata->>'sm_factory_delivery_id'=first.id) ORDER BY first.sequence LIMIT 64`,
        )
      ).rows;
      for (const row of rows) {
        if (this.halted || this.active.size >= this.concurrency) break;
        if (this.active.has(row.document_id)) continue;
        const task = this.deliver(row).catch(async () => {
          if (!this.halted)
            await this.fail(row, "delivery_error").catch(() => {});
        });
        this.active.set(row.document_id, task);
        this.track.add(task);
        void task.finally(() => {
          this.active.delete(row.document_id);
          this.track.delete(task);
        });
      }
      if (Date.now() - (this.lastPrune || 0) > 3600000) {
        this.lastPrune = Date.now();
        await this.pool.query(
          `DELETE FROM ${table} WHERE state='done' AND completed_at<now()-interval '7 days'`,
        );
      }
    } finally {
      this.scanning = false;
    }
  }
  halt() {
    this.halted = true;
    clearInterval(this.timer);
  }
  async stop() {
    this.halt();
    await this.scan?.catch(() => {});
    await Promise.allSettled([...this.active.values()]);
    this.key.fill(0);
  }
}
