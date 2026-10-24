import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { FORMAT, identityHash, open, readConnection } from "./runtime.mjs";

const input = process.env.FACTORY_TEST_PG_URL_FILE;
if (!input)
  throw new Error(
    "Set FACTORY_TEST_PG_URL_FILE to an isolated PostgreSQL 17 test service",
  );
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-pg-test-"));
const key = randomBytes(32),
  database = "factory_test_" + randomBytes(8).toString("hex");
const connectionFile = path.join(dir, "url");
let admin, client;
const runtimes = [];
beforeAll(async () => {
  const url = new URL(readConnection(input));
  admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  url.pathname = "/" + database;
  fs.writeFileSync(connectionFile, url.toString(), { mode: 0o600 });
  client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  await client.query(
    "CREATE EXTENSION vector; CREATE SCHEMA drizzle; CREATE TABLE drizzle.__factory_postgres_binding (singleton boolean PRIMARY KEY, identity text, format text); CREATE TABLE probe (id int PRIMARY KEY, value text); CREATE TABLE document (id text PRIMARY KEY)",
  );
  await client.query(
    "INSERT INTO drizzle.__factory_postgres_binding VALUES (true,$1,$2)",
    [identityHash(key), FORMAT],
  );
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
});
afterAll(async () => {
  await client?.end();
  await admin?.query(`DROP DATABASE "${database}"`);
  await admin?.end();
  fs.rmSync(dir, { recursive: true });
});
async function start(options = {}) {
  const runtime = await open({
    Pool: pg.Pool,
    key,
    connectionFile,
    install: () => {},
    migrate: async () => {},
    log: () => {},
    ...options,
  });
  runtimes.push(runtime);
  return runtime;
}

test("transactions keep one connection, isolate failures, and support savepoints", async () => {
  const r = await start();
  await r.db.transaction(async (tx) => {
    const first = (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    await tx.query("INSERT INTO probe VALUES (1,'committed')");
    await expect(
      tx.transaction(async (nested) => {
        await nested.query("INSERT INTO probe VALUES (2,'must roll back')");
        throw new Error("abort nested");
      }),
    ).rejects.toThrow("abort nested");
    const other = (await r.db.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    expect(other).not.toBe(first);
    expect((await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid).toBe(
      first,
    );
  });
  await expect(
    r.db.transaction(async (tx) => {
      await tx.query("INSERT INTO probe VALUES (3,'must roll back')");
      throw new Error("abort outer");
    }),
  ).rejects.toThrow("abort outer");
  expect((await client.query("SELECT id FROM probe ORDER BY id")).rows).toEqual(
    [{ id: 1 }],
  );
});

test("the pool runs independent requests concurrently", async () => {
  const r = await start({ max: 6 });
  const started = performance.now();
  const result = await Promise.all(
    Array.from({ length: 4 }, () =>
      r.db.query("SELECT pg_sleep(0.3), pg_backend_pid() AS pid"),
    ),
  );
  expect(new Set(result.map((x) => x.rows[0].pid)).size).toBe(4);
  expect(performance.now() - started).toBeLessThan(1100);
});

test("wrong identity and concurrent owners are refused and startup releases its pool", async () => {
  let captured;
  class ObservedPool extends pg.Pool {
    constructor(config) {
      super(config);
      captured = this;
    }
  }
  await expect(
    start({ Pool: ObservedPool, key: randomBytes(32) }),
  ).rejects.toThrow("identity");
  expect(captured.totalCount).toBe(0);
  await start();
  await expect(start({ Pool: ObservedPool })).rejects.toThrow(
    "Another Supermemory",
  );
  expect(captured.totalCount).toBe(0);
});

test("an unmarked database is never initialized by server startup", async () => {
  await client.query(
    "ALTER TABLE drizzle.__factory_postgres_binding RENAME TO saved_binding",
  );
  try {
    await expect(start()).rejects.toThrow("no completed migration");
  } finally {
    await client.query(
      "ALTER TABLE drizzle.saved_binding RENAME TO __factory_postgres_binding",
    );
  }
});

test("closing the runtime waits for active SQL and rejects subsequent operations", async () => {
  const r = await start();
  const pending = r.db.query("SELECT pg_sleep(0.2), 42 AS answer");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const closing = r.stop();
  expect((await pending).rows[0].answer).toBe(42);
  await closing;
  await r.stop();
  expect(r.pool.totalCount).toBe(0);
  await expect(r.db.query("SELECT 1")).rejects.toThrow("stopped");
});

test("losing the ownership connection stops the runtime", async () => {
  let notify;
  const lost = new Promise((resolve) => {
    notify = resolve;
  });
  const r = await start({ fatal: notify });
  await client.query("SELECT pg_terminate_backend($1)", [r.leasePid]);
  await Promise.race([
    lost,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("ownership loss was not reported")),
        2000,
      ),
    ),
  ]);
  await r.stop();
  expect(r.pool.totalCount).toBe(0);
  await expect(r.db.query("SELECT 1")).rejects.toThrow("stopped");
});

test("connection parse errors do not expose credentials", () => {
  const malformed = path.join(dir, "invalid");
  fs.writeFileSync(malformed, "postgresql://user:private-sentinel@[");
  try {
    readConnection(malformed);
    throw new Error("expected failure");
  } catch (error) {
    expect(error.message).toBe("Invalid Postgres connection file");
  }
});
