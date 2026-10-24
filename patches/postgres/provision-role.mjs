import fs from "node:fs";
import pg from "pg";
import { readConnection } from "./runtime.mjs";

export async function provisionRole({
  adminFile,
  role,
  passwordFile,
  outputFile,
}) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role || ""))
    throw new Error("Use a new lowercase application role name");
  if (!outputFile || fs.existsSync(outputFile))
    throw new Error("A new connection-file output path is required");
  const password = fs.readFileSync(passwordFile, "utf8").trim();
  if (password.length < 24)
    throw new Error("Application password must have at least 24 characters");
  const url = new URL(readConnection(adminFile));
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  const q = pg.escapeIdentifier;
  let output,
    commitAttempted = false,
    committed = false;
  try {
    // Reserve and sync the new file before committing ownership changes. A bad
    // output path must not leave a newly provisioned role without its config.
    output = fs.openSync(outputFile, "wx", 0o600);
    await client.query("BEGIN");
    const binding = (
      await client.query(
        "SELECT source_fingerprints FROM drizzle.__factory_postgres_binding WHERE singleton=true",
      )
    ).rows[0];
    if (!binding)
      throw new Error(
        "Only a completed dedicated migration can be provisioned",
      );
    const tables = (
      await client.query(
        "SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('public','drizzle') ORDER BY schemaname, tablename",
      )
    ).rows;
    const expected = new Set([
      ...Object.keys(binding.source_fingerprints),
      "drizzle.__factory_postgres_binding",
    ]);
    if (
      tables.some(
        (t) =>
          t.schemaname === "drizzle" &&
          t.tablename === "__factory_workflow_outbox",
      )
    )
      expected.add("drizzle.__factory_workflow_outbox");
    if (
      tables.some(
        (t) =>
          t.schemaname === "drizzle" &&
          t.tablename === "__factory_ingest_queue",
      )
    )
      expected.add("drizzle.__factory_ingest_queue");
    if (
      tables.length !== expected.size ||
      tables.some((t) => !expected.has(`${t.schemaname}.${t.tablename}`))
    )
      throw new Error(
        "Unexpected tables in destination; refusing ownership changes",
      );
    await client.query(
      `CREATE ROLE ${q(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${pg.escapeLiteral(password)}`,
    );
    const database = (await client.query("SELECT current_database() AS name"))
      .rows[0].name;
    await client.query(`ALTER DATABASE ${q(database)} OWNER TO ${q(role)}`);
    for (const schema of ["public", "drizzle"])
      await client.query(`ALTER SCHEMA ${q(schema)} OWNER TO ${q(role)}`);
    for (const t of tables)
      await client.query(
        `ALTER TABLE ${q(t.schemaname)}.${q(t.tablename)} OWNER TO ${q(role)}`,
      );
    // Owned identity/serial sequences change with their table; only transfer the rest.
    const sequences = (
      await client.query(
        "SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname IN ('public','drizzle') AND c.relowner<>(SELECT oid FROM pg_roles WHERE rolname=$1)",
        [role],
      )
    ).rows;
    for (const s of sequences)
      await client.query(
        `ALTER SEQUENCE ${q(s.nspname)}.${q(s.relname)} OWNER TO ${q(role)}`,
      );
    const enums = (
      await client.query(
        "SELECT n.nspname,t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typtype='e' AND n.nspname IN ('public','drizzle')",
      )
    ).rows;
    for (const t of enums)
      await client.query(
        `ALTER TYPE ${q(t.nspname)}.${q(t.typname)} OWNER TO ${q(role)}`,
      );
    url.username = role;
    url.password = password;
    fs.writeFileSync(output, url.toString());
    fs.fsyncSync(output);
    commitAttempted = true;
    await client.query("COMMIT");
    committed = true;
    return { applicationRole: role, superuser: false, tables: tables.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (output !== undefined) {
      fs.closeSync(output);
      // If COMMIT's response is lost, the role may already own the database.
      // Retain the synced connection file so recovery cannot lose its password.
      if (!committed && !commitAttempted) fs.unlinkSync(outputFile);
    }
    await client.end();
  }
}

if (import.meta.main) {
  const [adminFile, role, passwordFile, outputFile] = process.argv.slice(2);
  try {
    console.log(
      JSON.stringify(
        await provisionRole({ adminFile, role, passwordFile, outputFile }),
      ),
    );
  } catch (error) {
    console.error(
      error.code
        ? `Role provisioning failed (${error.code}); credentials withheld`
        : error.message,
    );
    process.exitCode = 1;
  }
}
