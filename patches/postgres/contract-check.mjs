// Synthetic-only write/delete checks. All real response contents stay in memory.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import pg from "pg";
import { readConnection } from "./runtime.mjs";

const [mode, address, keyFile, stateFile] = process.argv.slice(2);
if (
  ![
    "write",
    "enqueue",
    "create-parallel",
    "create-duplicate",
    "append-parallel",
    "crash-handoff",
    "check",
    "forget",
    "latency",
  ].includes(mode) ||
  !address ||
  !keyFile ||
  !stateFile
)
  throw new Error(
    "Usage: contract-check.mjs write|enqueue|create-parallel|create-duplicate|append-parallel|crash-handoff|check|forget|latency BASE_URL_OR_docker:CONTAINER KEY_FILE PRIVATE_STATE_FILE",
  );
let base = address;
if (address.startsWith("docker:")) {
  const container = address.slice(7);
  assert(
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container),
    "Invalid container name",
  );
  const inspected = spawnSync("docker", ["inspect", container], {
    encoding: "utf8",
  });
  assert.equal(inspected.status, 0, "Cannot inspect the candidate container");
  const binding = JSON.parse(inspected.stdout)[0]?.NetworkSettings?.Ports?.[
    "6767/tcp"
  ]?.[0];
  assert(binding?.HostPort, "Candidate API port is not published");
  base = "http://127.0.0.1:" + binding.HostPort;
}
const key = fs.readFileSync(keyFile, "utf8").trim();
const timings = [];
async function call(method, route, body, { authenticated = true, host } = {}) {
  const started = performance.now();
  const response = await fetch(base + route, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? { Authorization: `Bearer ${key}` } : {}),
      ...(host ? { Host: host } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  const data = await response.json().catch(() => null);
  timings.push({
    method,
    route: route.startsWith("/v3/documents/") ? "/v3/documents/:id" : route,
    status: response.status,
    elapsedMs: Math.round(performance.now() - started),
  });
  return { response, data };
}
function requireStatus(result, status) {
  assert.equal(
    result.response.status,
    status,
    `Unexpected HTTP status; response contents withheld`,
  );
  return result.data;
}
function save(state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}
async function waitForService() {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + "/v3/session", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(3000),
      });
      await response.arrayBuffer();
      if (response.status === 200) return;
      if (response.status === 401 || response.status === 403)
        throw new Error("Candidate rejected the configured API key");
    } catch (error) {
      if (error.message === "Candidate rejected the configured API key")
        throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Candidate did not become ready within two minutes");
}
async function ready(state) {
  const deadline = Date.now() + 300000;
  let previous;
  while (Date.now() < deadline) {
    const doc = requireStatus(
      await call("GET", "/v3/documents/" + encodeURIComponent(state.id)),
      200,
    );
    if (doc.status !== previous)
      console.log(JSON.stringify({ ingestion: doc.status }));
    previous = doc.status;
    if (doc.status === "failed")
      throw new Error("Synthetic document ingestion failed");
    if (doc.status === "done") return doc;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Synthetic ingestion did not finish within five minutes");
}
async function recalled(state) {
  const search = requireStatus(
    await call("POST", "/v4/search", {
      q: "What are the verification phrase and checkpoint label for this test?",
      containerTag: state.tag,
      limit: 10,
      include: { documents: true },
    }),
    200,
  );
  const text = JSON.stringify(search.results || []);
  assert(text.includes(state.marker), "First synthetic fact was not recalled");
  if (state.appended)
    assert(
      text.includes(state.appendMarker),
      "Appended synthetic fact was not recalled",
    );
  assert(
    search.results.some(
      (r) => Array.isArray(r.documents) && r.documents.length,
    ),
    "Document provenance is missing",
  );
  const profile = requireStatus(
    await call("POST", "/v4/profile", {
      containerTag: state.tag,
      q: "What are the verification phrase and checkpoint label?",
    }),
    200,
  );
  assert(
    Array.isArray(profile.profile?.static) &&
      Array.isArray(profile.profile?.dynamic),
  );
  assert(
    Array.isArray(profile.searchResults?.results) &&
      profile.searchResults.results.length > 0,
  );
  const empty = requireStatus(
    await call("POST", "/v4/search", {
      q: state.marker,
      containerTag: "factory_absent_" + randomUUID().replaceAll("-", ""),
      limit: 3,
    }),
    200,
  );
  assert.equal(empty.results.length, 0, "Search leaked across container tags");
}

try {
  await waitForService();
  requireStatus(
    await call("GET", "/v3/session", undefined, { authenticated: false }),
    401,
  );
  requireStatus(
    await call("GET", "/v3/session", undefined, {
      authenticated: false,
      host: "localhost",
    }),
    401,
  );
  requireStatus(await call("GET", "/v3/session"), 200);
  if (mode === "latency") {
    const tag = process.env.FACTORY_TEST_RECALL_TAG;
    assert(
      tag,
      "FACTORY_TEST_RECALL_TAG must name an existing populated test tag",
    );
    await call("POST", "/v4/profile", { containerTag: tag, q: "Tailscale" });
    const rounds = [];
    for (const concurrency of [1, 4, 8]) {
      const values = [];
      for (let round = 0; round < 3; round++)
        await Promise.all(
          Array.from({ length: concurrency }, async (_, index) => {
            const start = performance.now();
            const r = await call("POST", "/v4/profile", {
              containerTag: tag,
              q: [
                "Tailscale",
                "project memory",
                "server maintenance",
                "coding workflow",
              ][index % 4],
            });
            requireStatus(r, 200);
            values.push(Math.round(performance.now() - start));
          }),
        );
      values.sort((a, b) => a - b);
      rounds.push({
        concurrency,
        requests: values.length,
        p50Ms: values[Math.floor(values.length / 2)],
        p95Ms: values[Math.ceil(values.length * 0.95) - 1],
        maxMs: values.at(-1),
        over3000Ms: values.filter((v) => v > 3000).length,
      });
    }
    save({ rounds });
    console.log(JSON.stringify({ latency: rounds }));
  } else {
    let state;
    if (
      ["write", "enqueue", "create-parallel", "create-duplicate"].includes(mode)
    ) {
      assert(
        !fs.existsSync(stateFile),
        "State file exists; use check or a new private state file",
      );
      const suffix = randomUUID().replaceAll("-", "");
      state = {
        tag: "factory_pg_probe_" + suffix,
        customId: "factory_pg_probe_" + suffix,
        marker: "silver-cedar-" + suffix.slice(0, 8),
        appendMarker: "copper-seal-" + suffix.slice(0, 8),
        appended: false,
      };
      const context =
        "This container is a synthetic verification notebook. Extract explicit test fixture facts, including exact verification phrases and checkpoint labels. These are test facts, not preferences about a real person.";
      const initial = {
        customId: state.customId,
        containerTag: state.tag,
        content: `The factory database migration test uses the exact verification phrase ${state.marker}. The test calibration interval is seventeen minutes.`,
        metadata: { kind: "synthetic_postgres_validation" },
        entityContext: context,
      };
      const markers =
        mode === "create-duplicate"
          ? [state.marker, state.marker]
          : mode === "create-parallel"
            ? [
                state.marker,
                "first-beta-" + suffix.slice(0, 8),
                "first-gamma-" + suffix.slice(0, 8),
              ]
            : [state.marker];
      const replies = await Promise.all(
        markers.map((marker, index) =>
          call("POST", "/v3/documents", {
            ...initial,
            content:
              index === 0 || mode === "create-duplicate"
                ? initial.content
                : `Concurrent creation checkpoint ${index} has the exact independent value ${marker}.`,
          }),
        ),
      );
      const added = replies[0];
      assert([200, 201, 202].includes(added.response.status));
      assert.equal(typeof added.data?.id, "string");
      state.id = added.data.id;
      for (const reply of replies) {
        assert([200, 201, 202].includes(reply.response.status));
        assert.equal(
          reply.data.id,
          state.id,
          "Concurrent creation produced duplicate documents",
        );
      }
      save(state);
      if (mode === "enqueue")
        console.log(JSON.stringify({ acceptedForCrashRecoveryTest: true }));
      else if (mode === "create-parallel" || mode === "create-duplicate") {
        const doc = await ready(state);
        assert(
          markers.every((marker) => doc.content?.includes(marker)),
          "Concurrent creation lost captures",
        );
        if (mode === "create-duplicate")
          assert.equal(
            doc.content.split(state.marker).length - 1,
            1,
            "Duplicate capture repeated content",
          );
        await recalled(state);
        console.log(
          JSON.stringify({
            duplicateCreate: mode === "create-duplicate",
            concurrentCreation: true,
            oneDocument: true,
            capturesPreserved: markers.length,
          }),
        );
      } else {
        await ready(state);
        await recalled(state);
        const appended = await call("POST", "/v3/documents", {
          customId: state.customId,
          containerTag: state.tag,
          content: `The same factory database migration test also uses the exact checkpoint label ${state.appendMarker}. Its original verification phrase ${state.marker} remains valid.`,
          metadata: { kind: "synthetic_postgres_validation" },
          entityContext: context,
        });
        assert([200, 201, 202].includes(appended.response.status));
        assert.equal(
          appended.data.id,
          state.id,
          "Appending changed the document identity",
        );
        state.appended = true;
        save(state);
        const doc = await ready(state);
        assert(
          typeof doc.content === "string" &&
            doc.content.includes(state.marker) &&
            doc.content.includes(state.appendMarker),
          "Session append did not retain both pieces of content",
        );
        await recalled(state);
        state.verified = true;
        save(state);
        console.log(
          JSON.stringify({
            ingestion: true,
            appendPreservedIdentity: true,
            scopedRecall: true,
            profileRecall: true,
          }),
        );
      }
    } else {
      state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      assert(
        /^factory_pg_probe_[a-f0-9]{32}$/.test(state.tag) &&
          state.customId === state.tag &&
          typeof state.id === "string",
        "State is not a synthetic fixture owned by this tool",
      );
      if (mode === "append-parallel") {
        const suffix = randomUUID().slice(0, 8);
        const markers = ["alpha", "beta", "gamma"].map(
          (name) => `${name}-quartz-${suffix}`,
        );
        const replies = await Promise.all(
          markers.map((marker, index) =>
            call("POST", "/v3/documents", {
              customId: state.customId,
              containerTag: state.tag,
              content: `Concurrent fixture ${index + 1} has its own independent value ${marker}.`,
              metadata: { kind: "synthetic_postgres_validation" },
            }),
          ),
        );
        for (const reply of replies) {
          assert([200, 201, 202].includes(reply.response.status));
          assert.equal(reply.data.id, state.id);
        }
        state.parallelMarkers = markers;
        save(state);
        const doc = await ready(state);
        assert(
          markers.every((marker) => doc.content?.includes(marker)),
          "Concurrent appends lost document content",
        );
        await recalled(state);
        console.log(
          JSON.stringify({ concurrentAppendsPreserved: markers.length }),
        );
      } else if (mode === "crash-handoff") {
        assert(
          address.startsWith("docker:"),
          "Crash probe requires a Docker candidate",
        );
        const container = address.slice(7);
        const docker = (...args) => {
          const result = spawnSync("docker", args, { encoding: "utf8" });
          assert.equal(result.status, 0, "Candidate Docker command failed");
          return result.stdout;
        };
        const inspect = () => JSON.parse(docker("inspect", container))[0];
        assert(
          inspect().Config.Env.some(
            (entry) =>
              entry ===
              "FACTORY_SUPERMEMORY_RUNTIME=file:///data/postgres/runtime-probe.mjs",
          ),
          "Candidate must use the test-only runtime probe",
        );
        const before = await ready(state);
        const marker = "handoff-" + randomUUID().slice(0, 8);
        const db = new pg.Client({
          connectionString: readConnection(
            process.env.FACTORY_TEST_PG_URL_FILE,
          ),
        });
        await db.connect();
        try {
          docker(
            "exec",
            "--user",
            "99:100",
            container,
            "touch",
            "/data/store/factory-crash-after-commit",
          );
          await call("POST", "/v3/documents", {
            customId: state.customId,
            containerTag: state.tag,
            content: `The exact workflow handoff checkpoint is ${marker}.`,
            metadata: { kind: "factory_crash_handoff_probe" },
          }).catch(() => null);
          for (let i = 0; i < 100 && inspect().State.Running; i++)
            await new Promise((resolve) => setTimeout(resolve, 100));
          assert.equal(
            inspect().State.ExitCode,
            137,
            "Expected deterministic SIGKILL after COMMIT",
          );
          const saved = (
            await db.query(
              "SELECT envelope FROM drizzle.__factory_workflow_outbox WHERE document_id=$1",
              [state.id],
            )
          ).rows;
          assert.equal(saved.length, 1, "Committed workflow input is missing");
          assert(saved[0].envelope.length > 16);
          console.log(
            JSON.stringify({
              crashAfterCommitBeforeDispatch: true,
              workflowInputPersisted: true,
            }),
          );
          docker("start", container);
          base =
            "http://127.0.0.1:" +
            inspect().NetworkSettings.Ports["6767/tcp"][0].HostPort;
          await waitForService();
          const after = await ready(state);
          assert.equal(
            after.content.split(marker).length - 1,
            1,
            "Crash recovery lost or duplicated the new capture",
          );
          assert(
            after.content.includes(before.content),
            "Crash recovery lost the original content",
          );
          await recalled(state);
          console.log(
            JSON.stringify({
              workflowHandoffRecovered: true,
              duplicateCaptures: 0,
            }),
          );
        } finally {
          await db.end();
        }
      } else if (mode === "check") {
        await ready(state);
        await recalled(state);
        console.log(JSON.stringify({ persistedRecall: true }));
      } else {
        requireStatus(
          await call(
            "DELETE",
            "/v3/documents/" + encodeURIComponent(state.customId),
          ),
          204,
        );
        const search = requireStatus(
          await call("POST", "/v4/search", {
            q: state.marker,
            containerTag: state.tag,
            limit: 10,
          }),
          200,
        );
        assert.equal(
          search.results.length,
          0,
          "Forgotten document still has searchable memories",
        );
        const profile = requireStatus(
          await call("POST", "/v4/profile", {
            containerTag: state.tag,
            q: state.marker,
          }),
          200,
        );
        assert.equal(
          (profile.profile?.static?.length || 0) +
            (profile.profile?.dynamic?.length || 0) +
            (profile.searchResults?.results?.length || 0),
          0,
          "Forgotten facts remain in the profile",
        );
        state.forgotten = true;
        save(state);
        console.log(
          JSON.stringify({ forgotten: true, noResidualRecall: true }),
        );
      }
    }
  }
  console.log(
    JSON.stringify({
      requests: timings.length,
      slowRequests: timings.filter((t) => t.elapsedMs > 3000),
      maxMs: Math.max(...timings.map((t) => t.elapsedMs)),
    }),
  );
} catch (error) {
  // Assertions may otherwise print entire actual objects or response bodies.
  console.error(error.message.split("\n")[0]);
  console.log(
    JSON.stringify({ requests: timings.length, last: timings.at(-1) }),
  );
  process.exitCode = 1;
}
