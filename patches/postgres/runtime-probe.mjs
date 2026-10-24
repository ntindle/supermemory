// Test-only initializer: exercise the actual bundled Drizzle/pg constructors.
import fs from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import { open as openRuntime } from "./runtime.mjs";

export async function open(options) {
  const runtime = await openRuntime(options);
  try {
    const orm = options.drizzle({ client: runtime.pool }),
      sql = options.sql;
    const pids = new Set();
    let arrived = 0,
      release;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    const deadline = setTimeout(() => release(), 3000);
    const started = performance.now();
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        orm.transaction(async (tx) => {
          const pid = (
            await tx.execute(sql.raw("SELECT pg_backend_pid() AS pid"))
          ).rows[0].pid;
          pids.add(pid);
          await tx.execute(
            sql.raw(
              "CREATE TEMP TABLE factory_probe (value integer) ON COMMIT DROP",
            ),
          );
          await tx.execute(
            sql.raw(`INSERT INTO factory_probe VALUES (${index})`),
          );
          if (++arrived === 4) release();
          await barrier;
          assert.equal(
            arrived,
            4,
            "Transactions did not reserve independent connections",
          );
          await assert.rejects(
            tx.transaction(async (nested) => {
              await nested.execute(
                sql.raw("INSERT INTO factory_probe VALUES (99)"),
              );
              throw new Error("intentional savepoint rollback");
            }),
            /intentional savepoint rollback/,
          );
          const check = (
            await tx.execute(
              sql.raw(
                "SELECT count(*)::int AS count, min(value) AS value, pg_backend_pid() AS pid FROM factory_probe",
              ),
            )
          ).rows[0];
          assert.equal(check.count, 1);
          assert.equal(check.value, index);
          assert.equal(check.pid, pid);
        }),
      ),
    );
    clearTimeout(deadline);
    assert.equal(pids.size, 4);
    await assert.rejects(
      orm.transaction(async (tx) => {
        await tx.execute(
          sql.raw(
            "CREATE TEMP TABLE factory_rollback (value integer) ON COMMIT DROP",
          ),
        );
        await tx.execute(sql.raw("INSERT INTO factory_rollback VALUES (7)"));
        throw new Error("intentional outer rollback");
      }),
      /intentional outer rollback/,
    );
    const result = {
      bundledDriverTransactions: true,
      concurrentConnections: pids.size,
      nestedRollback: true,
      outerRollback: true,
      elapsedMs: Math.round(performance.now() - started),
    };
    if (process.env.FACTORY_PROBE_RESULT)
      fs.writeFileSync(
        process.env.FACTORY_PROBE_RESULT,
        JSON.stringify(result),
        { mode: 0o600 },
      );
    console.info("[factory-postgres-test] " + JSON.stringify(result));
    // Optional deterministic crash barrier. Only a separately armed, test-only
    // initializer can kill the process after PostgreSQL commits but before the
    // upstream request gets the result and schedules its workflow.
    const armFile = path.join(options.dir, "factory-crash-after-commit");
    const wrap = (client) => {
      if (client.factoryCrashProbe) return;
      client.factoryCrashProbe = true;
      const query = client.query;
      let target = false;
      client.query = function (...args) {
        const text =
          typeof args[0] === "string" ? args[0] : args[0]?.text || "";
        if (
          /UPDATE public\.document SET metadata/i.test(text) &&
          JSON.stringify(args[1] || args[0]?.values || []).includes(
            "factory_crash_handoff_probe",
          )
        )
          target = true;
        const result = query.apply(this, args);
        if (/^rollback$/i.test(text)) target = false;
        if (/^commit$/i.test(text) && target && result?.then) {
          target = false;
          return result.then((value) => {
            if (fs.existsSync(armFile)) {
              fs.unlinkSync(armFile);
              process.kill(process.pid, "SIGKILL");
            }
            return value;
          });
        }
        return result;
      };
    };
    for (const client of runtime.pool._clients) wrap(client);
    runtime.pool.on("connect", wrap);
    return runtime;
  } catch (error) {
    await runtime.stop();
    throw error;
  }
}
