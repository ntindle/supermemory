import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { IngestionQueue } from "./ingestion-queue.mjs";
import { readConnection } from "./runtime.mjs";

const table = "drizzle.__factory_ingest_queue";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-queue-test-"));
const key = randomBytes(32),
  database = "factory_queue_" + randomBytes(8).toString("hex");
// Mimic only Drizzle's parameter binding here. The real bundled Drizzle adapter
// is also exercised by runtime-probe and the full-server contract check.
const sql = (strings, ...values) => ({
  text: strings.reduce((text, part, i) => text + (i ? `$${i}` : "") + part, ""),
  values,
});
let admin, pool, queue, accepted;
async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback({ execute: (query) => client.query(query) });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
const app = {
  async fetch(request) {
    const route = new URL(request.url).pathname;
    if (request.headers.get("Authorization") !== "Bearer unit-test-only")
      return new Response(null, { status: 401 });
    if (route === "/v3/session") return Response.json({ org: { id: "org" } });
    if (request.method === "GET")
      return Response.json(
        (await pool.query("SELECT * FROM document WHERE id='doc'")).rows[0],
      );
    const payload = await request.json();
    return transaction(async (tx) => {
      await queue.lock(tx, "org", payload.customId);
      const document = (
        await tx.execute({
          text: "SELECT * FROM document WHERE id='doc' FOR UPDATE",
        })
      ).rows[0];
      const result = await queue.capture(
        tx,
        document,
        payload.customId,
        "org",
        ["tag"],
        payload.content,
        payload.metadata,
      );
      if (result) return Response.json({ id: "doc", status: result.status });
      if (document.content === payload.content)
        return Response.json({ id: "doc", status: "done" });
      // A stand-in for the upstream acceptance transaction, not its LLM workflow.
      await tx.execute(
        sql`UPDATE document SET content=content||${payload.content},metadata=${payload.metadata} WHERE id='doc'`,
      );
      await queue.stage(
        tx,
        {
          docId: "doc",
          metadata: payload.metadata,
          existingContent: document.content,
        },
        payload,
      );
      accepted.push(payload.content);
      return Response.json({ id: "doc", status: "done" });
    });
  },
};
async function start(options = {}) {
  queue = await new IngestionQueue({
    pool,
    sql,
    key,
    dir,
    pollMs: 600000,
    log: () => {},
    ...options,
  }).init();
  queue.bind(app, {});
}
async function capture(content, metadata = {}) {
  return transaction(async (tx) => {
    await queue.lock(tx, "org", "session");
    const doc = (
      await tx.execute({
        text: "SELECT * FROM document WHERE id='doc' FOR UPDATE",
      })
    ).rows[0];
    return queue.capture(tx, doc, "session", "org", ["tag"], content, metadata);
  });
}
async function drain() {
  for (let i = 0; i < 10; i++) {
    await queue.tick();
    await Promise.all([...queue.active.values()]);
    if (
      !(await pool.query(`SELECT 1 FROM ${table} WHERE state='pending'`))
        .rowCount
    )
      return;
  }
  throw new Error("Queue did not drain");
}
beforeAll(async () => {
  const url = new URL(readConnection(process.env.FACTORY_TEST_PG_URL_FILE));
  admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  url.pathname = "/" + database;
  pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
  await pool.query(
    "CREATE SCHEMA drizzle; CREATE TABLE document (id text PRIMARY KEY,org_id text,status text,content text,metadata jsonb)",
  );
  fs.writeFileSync(path.join(dir, "api-key"), "unit-test-only", {
    mode: 0o600,
  });
});
beforeEach(async () => {
  accepted = [];
  await start();
  await pool.query(
    `TRUNCATE ${table},drizzle.__factory_workflow_outbox,document; INSERT INTO document VALUES ('doc','org','processing','original', '{}')`,
  );
});
afterEach(async () => {
  await queue.stop();
});
afterAll(async () => {
  await pool?.end();
  await admin?.query(`DROP DATABASE "${database}"`);
  await admin?.end();
  fs.rmSync(dir, { recursive: true });
});

test("concurrent busy captures are encrypted, durable, FIFO, and visible until delivered", async () => {
  const replies = await Promise.all(
    ["alpha-secret", "beta-secret", "gamma-secret"].map((text) =>
      capture(text),
    ),
  );
  expect(replies.every((r) => r.status === "deferred")).toBe(true);
  const rows = (await pool.query(`SELECT * FROM ${table} ORDER BY sequence`))
    .rows;
  expect(rows).toHaveLength(3);
  expect(
    rows.every((row) => !row.envelope.includes(Buffer.from("secret"))),
  ).toBe(true);
  const expected = rows.map((row) => queue.decrypt(row).content);
  const response = await queue.fetch(
    new Request("http://test/v3/documents/doc", {
      headers: { Authorization: "Bearer unit-test-only" },
    }),
    {},
    app,
  );
  expect((await response.json()).status).toBe("queued");
  const rejected = await queue.fetch(
    new Request("http://test/v3/documents/doc"),
    {},
    app,
  );
  expect(rejected.status).toBe(401);
  await queue.stop();
  await start();
  await pool.query("UPDATE document SET status='done'");
  await drain();
  expect(accepted).toEqual(expected);
  expect(
    (await pool.query("SELECT content FROM document")).rows[0].content,
  ).toBe("original" + expected.join(""));
  expect(
    (
      await pool.query(
        `SELECT count(*)::int n FROM ${table} WHERE state='done' AND envelope IS NULL`,
      )
    ).rows[0].n,
  ).toBe(3);
});

test("capture inserts roll back with the source transaction and retries deduplicate", async () => {
  await expect(
    transaction(async (tx) => {
      await queue.capture(
        tx,
        { id: "doc", status: "processing" },
        "session",
        "org",
        ["tag"],
        "rollback",
        {},
      );
      throw new Error("abort");
    }),
  ).rejects.toThrow("abort");
  expect((await pool.query(`SELECT * FROM ${table}`)).rowCount).toBe(0);
  await capture("retry");
  await capture("retry");
  expect((await pool.query(`SELECT * FROM ${table}`)).rowCount).toBe(1);
});

test("a receipt reconciles a crash after acceptance without delivering twice", async () => {
  await capture("exactly-once");
  await pool.query("UPDATE document SET status='done'");
  const row = (await pool.query(`SELECT * FROM ${table}`)).rows[0];
  const original = queue.complete;
  queue.complete = async () => {
    throw new Error("simulated loss before acknowledgement");
  };
  await expect(queue.deliver(row)).rejects.toThrow("simulated loss");
  expect(accepted).toEqual(["exactly-once"]);
  queue.complete = original;
  await queue.stop();
  await start();
  await drain();
  expect(accepted).toEqual(["exactly-once"]);
  expect((await pool.query(`SELECT state FROM ${table}`)).rows[0].state).toBe(
    "done",
  );
});

test("tampered payloads are retained as failed and never acknowledged or silently bypassed", async () => {
  const metadata = {
    sm_factory_delivery_id: "forged",
    sm_factory_delivery_proof: "0".repeat(64),
  };
  await capture("must survive failure", metadata);
  expect(metadata).toEqual({});
  await pool.query(
    `UPDATE ${table} SET envelope=set_byte(envelope,15,get_byte(envelope,15)#255)`,
  );
  await pool.query("UPDATE document SET status='done'");
  await drain();
  const row = (await pool.query(`SELECT * FROM ${table}`)).rows[0];
  expect(row.state).toBe("failed");
  expect(row.envelope).not.toBeNull();
  expect(accepted).toEqual([]);
  await expect(capture("later")).rejects.toThrow("operator retry");
});

test("advisory locks serialize the same new session without blocking other sessions", async () => {
  let unlock, entered;
  const gate = new Promise((resolve) => {
    unlock = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const first = transaction(async (tx) => {
    await queue.lock(tx, "org", "new");
    entered();
    await gate;
  });
  await started;
  let secondEntered = false;
  const second = transaction(async (tx) => {
    await queue.lock(tx, "org", "new");
    secondEntered = true;
  });
  try {
    await transaction(async (tx) => {
      await queue.lock(tx, "org", "unrelated");
    });
    expect(secondEntered).toBe(false);
  } finally {
    unlock();
    await Promise.all([first, second]);
  }
  expect(secondEntered).toBe(true);
});

test("forget cascades to deferred content and delivery cannot recreate a deleted target", async () => {
  await capture("forgotten pending content");
  const row = (await pool.query(`SELECT * FROM ${table}`)).rows[0];
  await pool.query("DELETE FROM document WHERE id='doc'");
  expect((await pool.query(`SELECT * FROM ${table}`)).rowCount).toBe(0);
  expect(() =>
    queue.missing({
      sm_factory_delivery_id: row.id,
      sm_factory_delivery_proof: queue.proof(row.id, "doc"),
    }),
  ).toThrow("deleted");
  expect(queue.missing({})).toEqual({ action: "continue" });
});

test("a full document queue rejects new captures without acknowledging lost content", async () => {
  await pool.query(
    `INSERT INTO ${table}(id,org_id,document_id,custom_id,request_hash,envelope) SELECT 'full-'||n,'org','doc','session',n::text,''::bytea FROM generate_series(1,256) n`,
  );
  await expect(capture("not accepted")).rejects.toThrow("queue is full");
  expect(
    (await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
  ).toBe(256);
});

test("busy documents do not starve ready captures outside the first page", async () => {
  await pool.query(
    "INSERT INTO document SELECT 'a_'||n,'org','processing','', '{}'::jsonb FROM generate_series(1,64) n",
  );
  await pool.query(
    `INSERT INTO ${table}(id,org_id,document_id,custom_id,request_hash,envelope) SELECT 'busy-'||n,'org','a_'||n,'busy',n::text,''::bytea FROM generate_series(1,64) n`,
  );
  await capture("ready despite backlog");
  await pool.query("UPDATE document SET status='done' WHERE id='doc'");
  await queue.tick();
  await Promise.all([...queue.active.values()]);
  expect(accepted).toEqual(["ready despite backlog"]);
  expect(
    (
      await pool.query(
        `SELECT count(*)::int n FROM ${table} WHERE state='pending'`,
      )
    ).rows[0].n,
  ).toBe(64);
});

test("workflow input commits atomically with content and restarts use the same actor identity", async () => {
  const outbox = "drizzle.__factory_workflow_outbox";
  await expect(
    transaction(async (tx) => {
      await queue.stage(
        tx,
        { docId: "doc", existingContent: "before" },
        { content: "delta", org: { id: "org" } },
      );
      throw new Error("rollback stage");
    }),
  ).rejects.toThrow("rollback stage");
  expect((await pool.query(`SELECT * FROM ${outbox}`)).rowCount).toBe(0);
  const result = await transaction(async (tx) => {
    await tx.execute({
      text: "UPDATE document SET status='queued',content='delta'",
    });
    return queue.stage(
      tx,
      { docId: "doc", existingContent: "before" },
      { content: "delta", org: { id: "org" } },
    );
  });
  const row = (await pool.query(`SELECT * FROM ${outbox}`)).rows[0];
  expect(queue.wid(result)).toBe(row.id);
  expect(queue.decrypt(row).previousExtractedContent).toBe("before");
  expect(row.envelope.includes(Buffer.from("before"))).toBe(false);
  await queue.stop();
  let exists = false,
    unavailable = true;
  const dispatched = [];
  await start({
    rivet: async (id, params) => {
      if (params) {
        dispatched.push({ id, params });
        exists = true;
        return;
      }
      if (unavailable)
        throw Object.assign(new Error("engine unavailable"), {
          statusCode: 503,
        });
      if (!exists)
        throw Object.assign(new Error("not found"), {
          statusCode: 500,
          __type: "RivetError",
          group: "actor",
          code: "not_found",
        });
      return { status: "running" };
    },
  });
  await queue.workflows.recover();
  expect(dispatched).toHaveLength(0);
  unavailable = false;
  await pool.query(`UPDATE ${outbox} SET available_at=now()`);
  queue.workflows.lastScan = 0;
  await queue.workflows.recover();
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0].id).toBe(row.id);
  expect(dispatched[0].params.previousExtractedContent).toBe("before");
  await pool.query(`UPDATE ${outbox} SET available_at=now()`);
  queue.workflows.lastScan = 0;
  await queue.workflows.recover();
  expect(dispatched).toHaveLength(1);
  await pool.query("DELETE FROM document");
  expect((await pool.query(`SELECT * FROM ${outbox}`)).rowCount).toBe(0);
});

test("explicit retries persist a fresh actor and prevent new appends overwriting failed input", async () => {
  const input = {
    id: "doc",
    content: "retry delta",
    previousExtractedContent: "retained history",
    org: { id: "org" },
  };
  const first = await queue.retry(input);
  const second = await queue.retry(first);
  expect(queue.wid(first)).not.toBe(queue.wid(second));
  const row = (
    await pool.query(
      "SELECT * FROM drizzle.__factory_workflow_outbox WHERE document_id='doc'",
    )
  ).rows[0];
  expect(row.id).toBe(queue.wid(second));
  expect(queue.decrypt(row).previousExtractedContent).toBe("retained history");
  await pool.query("UPDATE document SET status='failed'");
  await expect(capture("would obscure failed input")).rejects.toThrow(
    "Previous ingestion failed",
  );
});

test("a deferred worker also refuses to overwrite an unresolved failed workflow", async () => {
  await capture("waiting delta");
  const row = (await pool.query(`SELECT * FROM ${table}`)).rows[0];
  await queue.retry({
    id: "doc",
    content: "failed delta",
    previousExtractedContent: "history",
    org: { id: "org" },
  });
  await pool.query("UPDATE document SET status='failed'");
  await expect(
    capture("waiting delta", {
      sm_factory_delivery_id: row.id,
      sm_factory_delivery_proof: queue.proof(row.id, "doc"),
    }),
  ).rejects.toThrow("Previous ingestion failed");
  expect((await pool.query(`SELECT state FROM ${table}`)).rows[0].state).toBe(
    "pending",
  );
});

test("a busy duplicate can drain when upstream accepts it as a content no-op", async () => {
  await capture("original");
  await pool.query("UPDATE document SET status='done'");
  await drain();
  expect(accepted).toEqual([]);
  expect(
    (await pool.query("SELECT content FROM document")).rows[0].content,
  ).toBe("original");
  expect((await pool.query(`SELECT state FROM ${table}`)).rows[0].state).toBe(
    "done",
  );
});
