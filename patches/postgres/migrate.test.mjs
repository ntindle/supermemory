import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { EncryptedFS } from "./encrypted-fs.mjs";
import { storeKey } from "./keys.mjs";
import { readConnection } from "./runtime.mjs";
import { migrate, fingerprint } from "./migrate.mjs";
import { provisionRole } from "./provision-role.mjs";

test("migration preserves vectors, exact numbers, generated columns, sequences, and foreign keys", async () => {
  const shared = process.env.FACTORY_TEST_SHARED_DIR,
    container = process.env.FACTORY_TEST_PG_CONTAINER;
  if (!shared || !container)
    throw new Error(
      "Set FACTORY_TEST_SHARED_DIR and FACTORY_TEST_PG_CONTAINER; the private directory must be mounted at the same path in that container",
    );
  const root = fs.mkdtempSync(path.join(shared, "migration-test-")),
    sourceDir = path.join(root, "source-copy");
  fs.mkdirSync(sourceDir, { mode: 0o700 });
  fs.writeFileSync(
    path.join(sourceDir, "machine-key"),
    "persist:" + randomUUID(),
    { mode: 0o600 },
  );
  const source = await PGlite.create({
    fs: new EncryptedFS(
      path.join(sourceDir, "pages.sqlite"),
      storeKey(sourceDir),
      { create: true },
    ),
    extensions: { vector },
  });
  await source.exec(`CREATE EXTENSION vector; CREATE SCHEMA drizzle;
    CREATE TYPE public.fixture_kind AS ENUM ('first', 'second');
    CREATE TABLE public.z_parent (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      precise numeric, moment timestamptz, payload jsonb, bytes bytea,
      embedding vector(3), kind fixture_kind, small int,
      generated int GENERATED ALWAYS AS (small * 2) STORED
    );
    CREATE TABLE public.a_child (id bigint PRIMARY KEY, parent_id bigint REFERENCES public.z_parent(id));
    CREATE TABLE drizzle.fixture (value text);
    INSERT INTO public.z_parent (id, precise, moment, payload, bytes, embedding, kind, small)
      OVERRIDING SYSTEM VALUE VALUES (9007199254740993, 12345678901234567890.123456789,
      '2026-01-02 03:04:05.123456+00', '{"unicode":"café","nested":[true,null,42]}',
      decode('0041ff','hex'), '[0.1,0.2,0.3]', 'second', 7);
    INSERT INTO public.a_child VALUES (1,9007199254740993);
    SELECT setval('public.z_parent_id_seq', 9007199254741000, true);
    CREATE INDEX fixture_vector ON public.z_parent USING hnsw (embedding vector_cosine_ops);`);
  const before = await fingerprint(source);
  await source.close();
  const adminUrl = readConnection(process.env.FACTORY_TEST_PG_URL_FILE);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const database = "factory_migration_test_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE DATABASE "${database}"`);
  const url = new URL(adminUrl);
  url.pathname = "/" + database;
  const targetFile = path.join(root, "target-url");
  fs.writeFileSync(targetFile, url.toString(), { mode: 0o600 });
  const target = new pg.Client({ connectionString: url.toString() });
  await target.connect();
  const appRole = "factory_role_" + randomUUID().replaceAll("-", "");
  let provisioned = false;
  try {
    const result = await migrate({
      sourceDir,
      connectionFile: targetFile,
      toolsContainer: container,
      outputDir: path.join(root, "result"),
      batchSize: 1,
      log: () => {},
    });
    expect(result.logicalRowsPreserved).toBe(true);
    expect(result.after).toEqual(before);
    const row = (
      await target.query(
        "SELECT id::text, precise::text, generated, encode(bytes,'hex') AS bytes FROM public.z_parent",
      )
    ).rows[0];
    expect(row).toEqual({
      id: "9007199254740993",
      precise: "12345678901234567890.123456789",
      generated: 14,
      bytes: "0041ff",
    });
    expect(
      (
        await target.query(
          "SELECT nextval('public.z_parent_id_seq')::text AS next",
        )
      ).rows[0].next,
    ).toBe("9007199254741001");
    await expect(
      target.query("INSERT INTO public.a_child VALUES (2,999)"),
    ).rejects.toMatchObject({ code: "23503" });
    expect(
      (
        await target.query(
          "SELECT indexname FROM pg_indexes WHERE indexname='fixture_vector'",
        )
      ).rows.length,
    ).toBe(1);
    const retryDir = path.join(root, "must-not-exist");
    await expect(
      migrate({
        sourceDir,
        connectionFile: targetFile,
        toolsContainer: container,
        outputDir: retryDir,
        log: () => {},
      }),
    ).rejects.toThrow("not empty");
    expect(fs.existsSync(retryDir)).toBe(false);
    const passwordFile = path.join(root, "app-password"),
      appFile = path.join(root, "app-url");
    fs.writeFileSync(passwordFile, randomUUID() + randomUUID(), {
      mode: 0o600,
    });
    await expect(
      provisionRole({
        adminFile: targetFile,
        role: appRole,
        passwordFile,
        outputFile: path.join(root, "missing", "url"),
      }),
    ).rejects.toThrow();
    expect(
      (await target.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [appRole]))
        .rows.length,
    ).toBe(0);
    await provisionRole({
      adminFile: targetFile,
      role: appRole,
      passwordFile,
      outputFile: appFile,
    });
    provisioned = true;
    const app = new pg.Client({ connectionString: readConnection(appFile) });
    await app.connect();
    try {
      const permissions = (
        await app.query(
          "SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user",
        )
      ).rows[0];
      expect(permissions).toEqual({
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
      });
      await app.query("INSERT INTO public.z_parent (small) VALUES (9)");
      await app.query("ALTER TABLE drizzle.fixture ADD COLUMN added integer");
    } finally {
      await app.end();
    }
  } finally {
    await target.end();
    await admin.query(`DROP DATABASE "${database}"`);
    if (provisioned) await admin.query(`DROP ROLE "${appRole}"`);
    await admin.end();
    fs.rmSync(root, { recursive: true });
  }
}, 60000);
