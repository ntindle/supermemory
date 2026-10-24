// Disposable empty server, same published binary as production. This never
// accepts an existing database/data directory or changes a production container.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { endpoint, newDirectory, readJson, secret, writeJson } from "./util.ts";

export const SERVER_IMAGE =
  "ghcr.io/ntindle/unraid-apps/supermemory@sha256:bfc389230f57c4a4425e9119fbffdc4806db9bd72dec97bbc18daed0615d6227";
export const DATABASE_IMAGE =
  "pgvector/pgvector@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d";
interface StackInputs {
  environmentFile: string;
  extractionModel: string;
  extraHosts?: string[];
  reader: {
    baseUrl: string;
    keyFile: string;
    model: string;
    reasoningEffort?: string;
  };
  judge: {
    baseUrl: string;
    keyFile: string;
    model: string;
    reasoningEffort?: string;
  };
}
export async function startStack(directory: string, input: StackInputs) {
  const envStat = fs.statSync(input.environmentFile);
  if (!envStat.isFile() || envStat.mode & 0o077)
    throw new Error(
      "Provider environment file must have mode 0600 or stricter",
    );
  const entries = fs
    .readFileSync(input.environmentFile, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const at = line.indexOf("=");
      if (at < 1) throw new Error("Invalid provider environment file");
      return [line.slice(0, at), line.slice(at + 1)];
    });
  const env = Object.fromEntries(entries);
  if (
    entries.length !== 3 ||
    entries.some(
      ([key, value]) =>
        !["OPENAI_MODEL", "OPENAI_API_KEY", "OPENAI_BASE_URL"].includes(key) ||
        !value,
    ) ||
    Object.keys(env).length !== 3 ||
    env.OPENAI_MODEL !== input.extractionModel
  )
    throw new Error(
      "Environment must contain only OPENAI_MODEL, OPENAI_API_KEY and OPENAI_BASE_URL, with the declared extraction model",
    );
  endpoint(env.OPENAI_BASE_URL, true);
  for (const model of [input.reader, input.judge]) {
    endpoint(model.baseUrl, true);
    secret(model.keyFile);
    if (!model.model) throw new Error("Missing reader/judge model");
  }
  directory = path.resolve(directory);
  newDirectory(directory);
  const id = randomBytes(8).toString("hex");
  const app = `sm-eval-app-${id}`,
    db = `sm-eval-db-${id}`,
    network = `sm-eval-${id}`,
    extractor = `sm-eval-files-${id}`;
  const docker = (args: string[], stdin?: string) => {
    const r = spawnSync("docker", args, {
      encoding: "utf8",
      input: stdin,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.status !== 0) {
      fs.appendFileSync(path.join(directory, "docker-private.log"), r.stderr, {
        mode: 0o600,
      });
      throw new Error(`Docker ${args[0]} failed; diagnostics kept private`);
    }
    return r.stdout;
  };
  const info = (name: string) => JSON.parse(docker(["inspect", name]))[0];
  const wait = async (fn: () => boolean, label: string, ms = 300000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (fn()) return;
      await Bun.sleep(500);
    }
    throw new Error(`${label} readiness deadline exceeded`);
  };
  writeJson(path.join(directory, "stack.json"), {
    id,
    app,
    db,
    network,
    image: SERVER_IMAGE,
  });
  docker(["pull", SERVER_IMAGE]);
  docker(["pull", DATABASE_IMAGE]);
  docker(["create", "--name", extractor, SERVER_IMAGE]);
  docker(["cp", `${extractor}:/opt/factory`, path.join(directory, "factory")]);
  docker(["rm", "--volumes", extractor]);
  const { storeKey } = await import(
    pathToFileURL(path.join(directory, "factory/postgres/keys.mjs")).href
  );
  const data = path.join(directory, "data"),
    store = path.join(data, "store");
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(
    path.join(store, "machine-key"),
    `persist:${randomBytes(24).toString("hex")}`,
    { mode: 0o600 },
  );
  const identity = createHash("sha256")
    .update(storeKey(store, "factory-postgres-v1"))
    .digest("hex");
  const adminPassword = randomBytes(32).toString("hex"),
    appPassword = randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(directory, "db-password"), adminPassword, {
    mode: 0o600,
  });
  const url = new URL(`postgresql://supermemory_app@${db}:5432/supermemory`);
  url.password = appPassword;
  fs.writeFileSync(path.join(store, "postgres-url"), url.toString(), {
    mode: 0o600,
  });
  docker([
    "network",
    "create",
    "--label",
    `factory.recall-eval=${id}`,
    network,
  ]);
  docker([
    "run",
    "-d",
    "--name",
    db,
    "--label",
    `factory.recall-eval=${id}`,
    "--network",
    network,
    "--memory",
    "1g",
    "--cpus",
    "2",
    "--shm-size",
    "256m",
    "--restart=no",
    "-v",
    `${directory}/db-password:/run/secrets/pg-password:ro`,
    "-e",
    "POSTGRES_PASSWORD_FILE=/run/secrets/pg-password",
    "-e",
    "POSTGRES_DB=supermemory",
    DATABASE_IMAGE,
    "-c",
    "log_min_error_statement=panic",
  ]);
  await wait(
    () =>
      spawnSync("docker", [
        "exec",
        db,
        "pg_isready",
        "-q",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
      ]).status === 0,
    "PostgreSQL",
    60000,
  );
  docker(
    [
      "exec",
      "-i",
      db,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "supermemory",
    ],
    `CREATE EXTENSION vector; CREATE SCHEMA drizzle; CREATE TABLE drizzle.__factory_postgres_binding(singleton boolean PRIMARY KEY CHECK(singleton),identity text NOT NULL,format text NOT NULL,source_fingerprints jsonb NOT NULL,completed_at timestamptz NOT NULL DEFAULT now()); INSERT INTO drizzle.__factory_postgres_binding(singleton,identity,format,source_fingerprints) VALUES(true,'${identity}','factory-supermemory-postgres-v1','{}'); CREATE ROLE supermemory_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${appPassword}'; ALTER DATABASE supermemory OWNER TO supermemory_app; ALTER SCHEMA public OWNER TO supermemory_app; ALTER SCHEMA drizzle OWNER TO supermemory_app; ALTER TABLE drizzle.__factory_postgres_binding OWNER TO supermemory_app;`,
  );
  docker([
    "run",
    "-d",
    "--name",
    app,
    "--label",
    `factory.recall-eval=${id}`,
    "--network",
    network,
    "--init",
    "--stop-timeout",
    "120",
    "--restart=no",
    "--memory",
    "3g",
    "--cpus",
    "2",
    "-p",
    "127.0.0.1::6767",
    "-v",
    `${data}:/data`,
    "--env-file",
    input.environmentFile,
    ...(input.extraHosts ?? []).flatMap((h) => ["--add-host", h]),
    "-e",
    "SUPERMEMORY_NO_OPEN=1",
    "-e",
    "SUPERMEMORY_NO_UPDATE_CHECK=1",
    "-e",
    "SUPERMEMORY_EMBEDDING_RAM_LIMIT=2gb",
    SERVER_IMAGE,
  ]);
  await wait(() => {
    const s = info(app).State;
    if (!s.Running) {
      fs.writeFileSync(
        path.join(directory, "app-private.log"),
        docker(["logs", app]),
        { mode: 0o600 },
      );
      throw new Error("Isolated app exited; private diagnostics retained");
    }
    return s.Health?.Status === "healthy";
  }, "Application");
  const keyFile = path.join(directory, "api-key");
  fs.writeFileSync(
    keyFile,
    docker(["exec", app, "cat", "/data/store/api-key"]).trim(),
    { mode: 0o600 },
  );
  const config = {
    baseUrl: `http://127.0.0.1:${info(app).NetworkSettings.Ports["6767/tcp"][0].HostPort}`,
    keyFile,
    deployment: {
      image: SERVER_IMAGE,
      extractionModel: input.extractionModel,
      embeddingModel: "Xenova/bge-base-en-v1.5/768",
    },
    reader: input.reader,
    judge: input.judge,
    topK: 10,
    threshold: 0.6,
    contextTokens: 2200,
    repeats: 3,
    seed: 20261024,
  };
  writeJson(path.join(directory, "config.private.json"), config);
  console.log(
    JSON.stringify({
      phase: "isolated-stack-ready",
      directory,
      app,
      db,
      config: path.join(directory, "config.private.json"),
    }),
  );
}
export function stopStack(directory: string) {
  const state = readJson<{ id: string; app: string; db: string }>(
    path.join(directory, "stack.json"),
  );
  for (const name of [state.app, state.db]) {
    const inspection = spawnSync("docker", ["inspect", name], {
      encoding: "utf8",
    });
    if (
      inspection.status !== 0 ||
      JSON.parse(inspection.stdout)[0].Config.Labels["factory.recall-eval"] !==
        state.id
    )
      throw new Error("Refusing to stop an unowned container");
    if (
      spawnSync("docker", ["stop", "-t", "120", name], { stdio: "ignore" })
        .status !== 0
    )
      throw new Error("Could not stop owned evaluation container");
  }
}
