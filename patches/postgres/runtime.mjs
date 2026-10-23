import fs from "node:fs";
import { createHash } from "node:crypto";
import { IngestionQueue } from "./ingestion-queue.mjs";

export const FORMAT = "factory-supermemory-postgres-v1";
export const LOCK = [1936549232, 1735357044];
export const identityHash = (key) =>
  createHash("sha256").update(key).digest("hex");

export function readConnection(
  filename = process.env.FACTORY_SUPERMEMORY_DATABASE_URL_FILE,
) {
  if (!filename)
    throw new Error("FACTORY_SUPERMEMORY_DATABASE_URL_FILE is required");
  let value;
  try {
    value = fs.readFileSync(filename, "utf8").trim();
  } catch {
    throw new Error("Cannot read the Postgres connection file");
  }
  try {
    const url = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      !url.pathname.slice(1)
    )
      throw new Error();
  } catch {
    throw new Error("Invalid Postgres connection file");
  }
  return value;
}

// The upstream migration/embedding helpers use PGlite's small raw SQL interface.
// Application queries use the bundled native node-postgres Drizzle adapter instead.
export class SqlDatabase {
  constructor(pool, client = null, state = { stopped: false, savepoint: 0 }) {
    this.pool = pool;
    this.client = client;
    this.state = state;
  }
  check() {
    if (this.state.stopped) throw new Error("Postgres runtime is stopped");
  }
  async query(text, values = []) {
    this.check();
    const result = await (this.client || this.pool).query(text, values);
    return { ...result, affectedRows: result.rowCount ?? 0 };
  }
  async exec(text) {
    this.check();
    const result = await (this.client || this.pool).query(text);
    return (Array.isArray(result) ? result : [result]).map((r) => ({
      ...r,
      affectedRows: r.rowCount ?? 0,
    }));
  }
  async transaction(callback) {
    this.check();
    const client = this.client || (await this.pool.connect());
    const nested = Boolean(this.client);
    const savepoint = `factory_${++this.state.savepoint}`;
    let releaseError;
    try {
      await client.query(nested ? `SAVEPOINT ${savepoint}` : "BEGIN");
      const result = await callback(
        new SqlDatabase(this.pool, client, this.state),
      );
      await client.query(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query(
          nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : "ROLLBACK",
        );
      } catch (rollbackError) {
        releaseError = rollbackError;
      }
      throw error;
    } finally {
      if (!nested) client.release(releaseError);
    }
  }
}

export async function open({
  Pool,
  sql,
  dir,
  track,
  rivet,
  key,
  install,
  migrate,
  log = console.info,
  connectionFile = process.env.FACTORY_SUPERMEMORY_DATABASE_URL_FILE,
  max = Number(process.env.FACTORY_SUPERMEMORY_PG_CONNECTIONS || 8),
  fatal = () => process.exit(1),
}) {
  if (!Number.isInteger(max) || max < 2 || max > 32)
    throw new Error("Postgres pool size must be between 2 and 32");
  if (!(key instanceof Uint8Array) || key.length !== 32)
    throw new Error("A derived machine identity is required");
  // Pool MUST come from the executable: bundled Drizzle uses instanceof against
  // that exact constructor to reserve a connection for each transaction.
  const pool = new Pool({
    connectionString: readConnection(connectionFile),
    max,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 30000,
    application_name: "factory-supermemory",
    statement_timeout: 30000,
    options: "-c timezone=UTC",
  });
  pool.on("error", (error) =>
    log(`[factory-postgres] idle connection failed (${safeCode(error)})`),
  );
  const db = new SqlDatabase(pool);
  let lease,
    queue,
    stopping,
    initialized = false;
  const stop = () =>
    (stopping ||= (async () => {
      db.state.stopped = true;
      await queue?.stop();
      if (lease) {
        lease.release(true);
        lease = null;
      }
      await pool.end();
      log("[factory-postgres] pool closed");
    })());
  try {
    lease = await pool.connect();
    lease.on("error", () => {
      if (stopping) return;
      db.state.stopped = true;
      log("[factory-postgres] database ownership connection lost; stopping");
      void stop().catch(() => {});
      if (initialized) fatal();
    });
    const version = Number(
      (await lease.query("SHOW server_version_num")).rows[0].server_version_num,
    );
    if (version < 170000 || version >= 180000)
      throw new Error("PostgreSQL 17 is required");
    if (
      !(
        await lease.query("SELECT pg_try_advisory_lock($1, $2) AS locked", LOCK)
      ).rows[0].locked
    )
      throw new Error("Another Supermemory process owns this database");
    const bindingTable = (
      await lease.query(
        "SELECT to_regclass('drizzle.__factory_postgres_binding') AS name",
      )
    ).rows[0].name;
    if (!bindingTable)
      throw new Error(
        "Database has no completed migration; refusing an empty or unrelated database",
      );
    const binding = (
      await lease.query(
        "SELECT identity, format FROM drizzle.__factory_postgres_binding WHERE singleton=true",
      )
    ).rows[0];
    if (
      !binding ||
      binding.format !== FORMAT ||
      binding.identity !== identityHash(key)
    )
      throw new Error("Database does not belong to this machine identity");
    const extension = (
      await lease.query(
        "SELECT extversion FROM pg_extension WHERE extname='vector'",
      )
    ).rows[0]?.extversion;
    if (!/^0\.8\.\d+$/.test(extension || ""))
      throw new Error("pgvector 0.8.x is required");
    // No full-store snapshots, WASM database, or application VACUUM timer.
    // PostgreSQL owns WAL, checkpoints, autovacuum, and independent connections.
    await migrate(db);
    queue = await new IngestionQueue({
      pool,
      sql,
      key,
      dir,
      track,
      rivet,
      log,
    }).init();
    globalThis.__sm = queue;
    install(pool);
    initialized = true;
    log(
      `[factory-postgres] PostgreSQL 17; pgvector ${extension}; pool limit=${max}; external persistence`,
    );
    return { db, pool, stop, queue, leasePid: lease.processID };
  } catch (error) {
    await stop().catch(() => {});
    if (error.code)
      throw new Error(`Postgres startup failed (${safeCode(error)})`);
    throw error;
  }
}

function safeCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_]{2,25}$/.test(error.code)
    ? error.code
    : "connection_error";
}
