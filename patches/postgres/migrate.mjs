// Migrate an OFFLINE COPY of the encrypted page store. Never open the live store.
// Native pg_dump exports schema only; data moves in bounded JSON batches so a
// large table cannot trigger PGlite's whole-COPY-result buffering limit.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { EncryptedFS } from "./encrypted-fs.mjs";
import { storeKey } from "./keys.mjs";
import { FORMAT, identityHash, readConnection } from "./runtime.mjs";

export const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
export async function fingerprint(db) {
  await db.query("SET timezone='UTC'");
  const tables = (
    await db.query(
      "SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('public','drizzle') AND tablename <> '__factory_postgres_binding' ORDER BY schemaname, tablename",
    )
  ).rows;
  const result = {};
  for (const { schemaname, tablename } of tables) {
    const name = `${quote(schemaname)}.${quote(tablename)}`;
    result[`${schemaname}.${tablename}`] = (
      await db.query(
        `SELECT count(*)::text AS count, md5(coalesce(string_agg(h, '' ORDER BY h COLLATE "C"), '')) AS digest FROM (SELECT md5(row_to_json(t)::text) h FROM ${name} t) hashed`,
      )
    ).rows[0];
  }
  return result;
}

async function runTool(
  container,
  command,
  args,
  logFile,
  passFile,
  stdoutFile,
) {
  const log = fs.openSync(logFile, "a", 0o600);
  const stdout = stdoutFile ? fs.openSync(stdoutFile, "wx", 0o600) : log;
  try {
    const child = spawn(
      "docker",
      [
        "exec",
        "--user",
        `${process.getuid()}:${process.getgid()}`,
        ...(passFile ? ["--env", `PGPASSFILE=${passFile}`] : []),
        container,
        command,
        ...args,
      ],
      { stdio: ["ignore", stdout, log] },
    );
    await new Promise((resolve, reject) => {
      child.once("error", () =>
        reject(
          new Error(
            `${command} could not start; inspect the private migration log`,
          ),
        ),
      );
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(`${command} failed; inspect the private migration log`),
            ),
      );
    });
  } finally {
    if (stdout !== log) fs.closeSync(stdout);
    fs.closeSync(log);
  }
}

export async function migrate({
  sourceDir,
  connectionFile,
  toolsContainer,
  outputDir,
  batchSize = 256,
  log = console.info,
}) {
  if (!sourceDir || !connectionFile || !toolsContainer || !outputDir)
    throw new Error(
      "Source copy, connection file, tools container, and new output directory are required",
    );
  if (fs.existsSync(outputDir))
    throw new Error(
      "Output directory already exists; preserve it and use a new migration directory",
    );
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1024)
    throw new Error("Invalid batch size");
  const connectionString = readConnection(connectionFile);
  const url = new URL(connectionString),
    database = decodeURIComponent(url.pathname.slice(1));
  const target = new pg.Client({
    connectionString,
    application_name: "factory-supermemory-migration",
  });
  let source, socket;
  await target.connect();
  try {
    const tables = (
      await target.query(
        "SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('public','drizzle')",
      )
    ).rows;
    if (tables.length)
      throw new Error(
        "Destination database is not empty; refusing to overwrite it",
      );
    const systemId = (
      await target.query(
        "SELECT system_identifier::text AS id FROM pg_control_system()",
      )
    ).rows[0].id;
    // Verify the tools container and connection file address the same cluster.
    const child = spawn(
      "docker",
      [
        "exec",
        toolsContainer,
        "psql",
        "-U",
        "postgres",
        "-d",
        database,
        "-At",
        "-c",
        "SELECT system_identifier::text FROM pg_control_system()",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (part) => {
      output += part;
    });
    child.stderr.resume();
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (code !== 0 || output.trim() !== systemId)
      throw new Error("Tools container does not match the destination cluster");
    fs.mkdirSync(outputDir, { mode: 0o700 });
    const started = Date.now();
    const storage = new EncryptedFS(
      path.join(sourceDir, "pages.sqlite"),
      storeKey(sourceDir),
    );
    source = await PGlite.create({
      fs: storage,
      extensions: { vector },
      relaxedDurability: false,
    });
    const before = await fingerprint(source);
    fs.writeFileSync(
      path.join(outputDir, "source-fingerprints.json"),
      JSON.stringify(before, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    log(
      JSON.stringify({
        phase: "source-fingerprint",
        tables: Object.keys(before).length,
      }),
    );
    // The embedded single-user client bypasses login, but pg_dump does not. Give
    // the OFFLINE COPY a dedicated export login; no application table changes.
    const exportUser = "factory_migration_export",
      password = randomBytes(32).toString("hex");
    const exists = (
      await source.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
        exportUser,
      ])
    ).rows.length;
    await source.exec(
      `${exists ? "ALTER" : "CREATE"} ROLE ${exportUser} WITH SUPERUSER LOGIN PASSWORD '${password}'`,
    );
    const passFile = path.join(outputDir, "export.pgpass");
    fs.writeFileSync(passFile, `*:*:*:${exportUser}:${password}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    const socketDir = path.join(outputDir, "socket");
    fs.mkdirSync(socketDir, { mode: 0o700 });
    socket = new PGLiteSocketServer({
      db: source,
      path: path.join(socketDir, ".s.PGSQL.5432"),
      maxConnections: 1,
      debug: false,
      inspect: false,
    });
    await socket.start();
    const schemaFile = path.join(outputDir, "schema.dump"),
      logFile = path.join(outputDir, "tools-private.log");
    await runTool(
      toolsContainer,
      "pg_dump",
      [
        "--host",
        socketDir,
        "--port",
        "5432",
        "--username",
        exportUser,
        "--dbname",
        "postgres",
        "--schema-only",
        "--schema",
        "public",
        "--schema",
        "drizzle",
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--file",
        schemaFile,
      ],
      logFile,
      passFile,
    );
    fs.chmodSync(schemaFile, 0o600);
    await socket.stop();
    socket = null;
    const tocFile = path.join(outputDir, "schema.list");
    await runTool(
      toolsContainer,
      "pg_restore",
      ["--list", schemaFile],
      logFile,
      null,
      tocFile,
    );
    // Native databases already have public. Keep its extension and ownership;
    // exclude only the archive's CREATE SCHEMA public entry, not its objects.
    const toc = fs
      .readFileSync(tocFile, "utf8")
      .split("\n")
      .map((line) =>
        /^\d+; \d+ \d+ SCHEMA - public(?: |$)/.test(line) ? "; " + line : line,
      )
      .join("\n");
    fs.writeFileSync(tocFile, toc);
    await target.query("CREATE EXTENSION IF NOT EXISTS vector");
    await runTool(
      toolsContainer,
      "pg_restore",
      [
        "--username",
        "postgres",
        "--dbname",
        database,
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        "--single-transaction",
        "--section=pre-data",
        "--use-list",
        tocFile,
        schemaFile,
      ],
      logFile,
    );
    log(JSON.stringify({ phase: "schema-created" }));
    const list = (
      await source.query(
        "SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('public','drizzle') ORDER BY schemaname, tablename",
      )
    ).rows;
    await target.query("BEGIN");
    try {
      for (const { schemaname, tablename } of list) {
        const name = `${quote(schemaname)}.${quote(tablename)}`;
        const columns = (
          await source.query(
            "SELECT a.attname FROM pg_attribute a WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='' ORDER BY a.attnum",
            [name],
          )
        ).rows
          .map((r) => quote(r.attname))
          .join(",");
        let rows = 0;
        await source.transaction(async (tx) => {
          await tx.exec(
            `DECLARE factory_copy NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS payload FROM ${name} t`,
          );
          for (;;) {
            const batch = (
              await tx.query(`FETCH FORWARD ${batchSize} FROM factory_copy`)
            ).rows;
            if (!batch.length) break;
            // Keep numeric precision and timestamp text: do not JSON.parse rows.
            const payload = "[" + batch.map((r) => r.payload).join(",") + "]";
            await target.query(
              `INSERT INTO ${name} (${columns}) OVERRIDING SYSTEM VALUE SELECT ${columns} FROM json_populate_recordset(NULL::${name}, $1::json)`,
              [payload],
            );
            rows += batch.length;
            if (rows % (batchSize * 64) === 0)
              log(
                JSON.stringify({
                  phase: "copy-progress",
                  table: `${schemaname}.${tablename}`,
                  rows,
                }),
              );
          }
          await tx.exec("CLOSE factory_copy");
        });
        log(
          JSON.stringify({
            phase: "table-copied",
            table: `${schemaname}.${tablename}`,
            rows,
          }),
        );
      }
      const sequences = (
        await source.query(
          "SELECT schemaname, sequencename FROM pg_sequences WHERE schemaname IN ('public','drizzle') ORDER BY schemaname, sequencename",
        )
      ).rows;
      for (const { schemaname, sequencename } of sequences) {
        const name = `${quote(schemaname)}.${quote(sequencename)}`;
        const value = (
          await source.query(`SELECT last_value::text, is_called FROM ${name}`)
        ).rows[0];
        await target.query(
          "SELECT setval($1::regclass, $2::bigint, $3::boolean)",
          [name, value.last_value, value.is_called],
        );
      }
      await target.query("COMMIT");
    } catch (error) {
      await target.query("ROLLBACK");
      throw error;
    }
    log(JSON.stringify({ phase: "building-indexes-and-constraints" }));
    await runTool(
      toolsContainer,
      "pg_restore",
      [
        "--username",
        "postgres",
        "--dbname",
        database,
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        "--single-transaction",
        "--section=post-data",
        "--use-list",
        tocFile,
        schemaFile,
      ],
      logFile,
    );
    await target.query("ANALYZE");
    const after = await fingerprint(target),
      sourceAfter = await fingerprint(source);
    if (
      JSON.stringify(before) !== JSON.stringify(after) ||
      JSON.stringify(before) !== JSON.stringify(sourceAfter)
    )
      throw new Error(
        "Logical fingerprints differ; destination is not ready for the application",
      );
    await target.query(
      "CREATE TABLE drizzle.__factory_postgres_binding (singleton boolean PRIMARY KEY CHECK (singleton), identity text NOT NULL, format text NOT NULL, source_fingerprints jsonb NOT NULL, completed_at timestamptz NOT NULL DEFAULT now())",
    );
    await target.query(
      "INSERT INTO drizzle.__factory_postgres_binding (singleton, identity, format, source_fingerprints) VALUES (true,$1,$2,$3::jsonb)",
      [
        identityHash(storeKey(sourceDir, "factory-postgres-v1")),
        FORMAT,
        JSON.stringify(before),
      ],
    );
    const evidence = {
      logicalRowsPreserved: true,
      before,
      after,
      elapsedSeconds: (Date.now() - started) / 1000,
    };
    fs.writeFileSync(
      path.join(outputDir, "evidence.json"),
      JSON.stringify(evidence, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    log(
      JSON.stringify({
        phase: "complete",
        logicalRowsPreserved: true,
        tables: Object.keys(after).length,
        elapsedSeconds: evidence.elapsedSeconds,
      }),
    );
    return evidence;
  } finally {
    if (socket) await socket.stop();
    if (source) await source.close();
    await target.end();
  }
}

if (import.meta.main) {
  const [sourceDir, connectionFile, toolsContainer, outputDir] =
    process.argv.slice(2);
  try {
    await migrate({ sourceDir, connectionFile, toolsContainer, outputDir });
  } catch (error) {
    // Database error detail can contain private row data. Keep it off stdout/stderr.
    const detail =
      outputDir && fs.existsSync(outputDir)
        ? path.join(outputDir, "failure-private.txt")
        : null;
    if (detail)
      fs.writeFileSync(detail, String(error.stack || error), { mode: 0o600 });
    console.error(
      error.code
        ? `Migration failed (${error.code}); inspect private diagnostics`
        : error.message,
    );
    process.exitCode = 1;
  }
}
