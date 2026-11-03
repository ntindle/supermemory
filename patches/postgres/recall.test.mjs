import { expect, test } from "bun:test";
import {
  dedupeProfile,
  dedupeSearch,
  distinct,
  fetchLimit,
  mcp,
  recall,
  resultText,
  TOOLS,
} from "./recall.mjs";

const fact = "Supermemory reaches the Gateway on port 8317 from its container";
const reworded = [
  fact,
  "From its container, Supermemory reaches the Gateway on port 8317",
  "Supermemory, from its container, reaches the Gateway using port 8317",
];
const other = "T3 Code servers update through scripts that wait for quiet";

// A stand-in for the upstream app: answers by "METHOD /path", records every call.
function fakeApp(routes) {
  const calls = [];
  return {
    calls,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "GET" ? undefined : await request.text();
      calls.push({
        method: request.method,
        path: url.pathname,
        host: request.headers.get("host") || url.host,
        auth: request.headers.get("authorization"),
        body: body ? JSON.parse(body) : undefined,
      });
      const route = routes[`${request.method} ${url.pathname}`];
      if (!route) return Response.json({ error: "Not found" }, { status: 404 });
      const [status, data] = await route(calls.at(-1));
      return Response.json(data, { status });
    },
  };
}
const sessionOk = () => [
  200,
  {
    org: { name: "Local", slug: "local", id: "org1" },
    session: { id: "secret-session" },
  },
];

test("distinct keeps the ranking and drops rewordings of a kept item", () => {
  expect(distinct([...reworded, other])).toEqual([fact, other]);
  expect(distinct([other, ...reworded])).toEqual([other, fact]);
  expect(distinct(["a b c", "d e f"])).toEqual(["a b c", "d e f"]);
  expect(distinct([], (x) => x)).toEqual([]);
});

test("facts that differ in a name, number, file or short swap stay apart", () => {
  const apart = [
    [
      "The hosted plan includes Postgres 17 and nightly backups.",
      "The hosted plan includes Redis 17 and nightly backups.",
    ],
    [
      "Applying release v8.0.46 restarts the proxy.",
      "Applying release v8.0.48 restarts the proxy.",
    ],
    [
      "In the notes repository, `docs/upgrade.md` documents moving every install to the new release, while `scripts/upgrade/` holds its steps.",
      "In the notes repository, `docs/pairing.md` documents pairing every install to the new release servers, while `scripts/pairing/` holds its steps.",
    ],
    // Few shared words: below SHORT_DUPLICATE this needs LONG_SHARED of them.
    [
      "The user has a hotel booked in Lisbon for the conference.",
      "The user has flights booked to Lisbon for the conference.",
    ],
  ];
  for (const pair of apart) expect(distinct(pair)).toEqual(pair);
});

test("a rewording that adds no content word collapses; a contradiction never does", () => {
  const rewording = [
    "Apps connect to servers using pairing codes or links, not SSH environments.",
    "Apps connect to servers by pairing code/link rather than as SSH environments.",
  ];
  expect(distinct(rewording)).toEqual([rewording[0]]);
  const restatement = [
    "Release v8.0.46 includes streaming and security fixes; applying it disconnects agents.",
    "Applying release v8.0.46 disconnects agents.",
  ];
  expect(distinct(restatement)).toEqual([restatement[0]]);
  // The shorter one first: the longer adds facts, so both stay.
  expect(distinct([...restatement].reverse())).toHaveLength(2);
  const contradiction = [
    "The proxy restarts after an upgrade.",
    "The proxy never restarts after an upgrade.",
  ];
  expect(distinct(contradiction)).toEqual(contradiction);
  expect(distinct([...contradiction].reverse())).toHaveLength(2);
});

test("rewordings collapse, short or long, and empty texts never do", () => {
  const short = [
    "Changing the proxy configuration requires the owner's approval.",
    "Changing proxy configuration requires the owner's prior approval.",
  ];
  expect(distinct(short)).toEqual([short[0]]);
  const long = [
    "Release commits are unsigned and use `git commit --no-gpg-sign` with the author set to Sam Rivera <sam@example.com>.",
    "Commits for releases should be unsigned with `git commit --no-gpg-sign` and authored as Sam Rivera <sam@example.com>.",
  ];
  expect(distinct(long)).toEqual([long[0]]);
  expect(distinct([{}, {}], resultText)).toHaveLength(2);
});

test("search results collapse, trim to the limit and keep total consistent", () => {
  const data = {
    results: [
      ...reworded,
      other,
      "a third, unrelated fact about Executor tokens",
    ].map((memory, i) => ({
      memory,
      similarity: 0.9 - i / 10,
    })),
    total: 5,
  };
  const out = dedupeSearch(data, 2);
  expect(out.results.map((r) => r.memory)).toEqual([fact, other]);
  expect(out.total).toBe(2);
  expect(
    dedupeSearch({ results: [{ chunk: fact }, { chunk: reworded[1] }] })
      .results,
  ).toHaveLength(1);
  expect(dedupeSearch({ nothing: true })).toEqual({ nothing: true });
});

test("profile lists collapse, and dynamic facts that repeat a static one go", () => {
  const out = dedupeProfile({
    profile: {
      static: [fact, reworded[1], other],
      dynamic: [reworded[2], "something new today"],
    },
    searchResults: {
      results: [{ memory: fact }, { memory: reworded[2] }, { memory: other }],
    },
  });
  expect(out.profile.static).toEqual([fact, other]);
  expect(out.profile.dynamic).toEqual(["something new today"]);
  expect(out.searchResults.results.map((r) => r.memory)).toEqual([fact, other]);
});

test("/v4/search over-fetches, then returns the requested number of distinct results", async () => {
  const app = fakeApp({
    "POST /v4/search": () => [
      200,
      {
        results: [...reworded, other, "x y z"].map((memory) => ({ memory })),
        total: 5,
        timing: 3,
      },
    ],
  });
  const request = new Request("http://guard/v4/search", {
    method: "POST",
    headers: { Authorization: "Bearer k", "Content-Type": "application/json" },
    body: JSON.stringify({ q: "port", containerTag: "t", limit: 2 }),
  });
  const response = await recall(request, {}, app);
  expect(app.calls[0].body.limit).toBe(6);
  expect(app.calls[0].auth).toBe("Bearer k");
  const data = await response.json();
  expect(data.results.map((r) => r.memory)).toEqual([fact, other]);
  expect(data.total).toBe(2);
  expect(data.timing).toBe(3);
});

test("over-fetching never asks upstream for fewer results than requested", async () => {
  expect([1, 2, 20, 50, 80].map(fetchLimit)).toEqual([3, 6, 50, 50, 80]);
  const app = fakeApp({ "POST /v4/search": () => [200, { results: [] }] });
  await recall(
    new Request("http://guard/v4/search", {
      method: "POST",
      body: JSON.stringify({ q: "x", containerTag: "t", limit: 80 }),
    }),
    {},
    app,
  );
  expect(app.calls[0].body.limit).toBe(80);
});

test("the opt-out header, errors and other routes pass through untouched", async () => {
  const app = fakeApp({
    "POST /v4/search": () => [
      200,
      { results: reworded.map((memory) => ({ memory })) },
    ],
    "POST /v4/profile": () => [503, { error: "busy" }],
  });
  const off = new Request("http://guard/v4/search", {
    method: "POST",
    headers: { "x-factory-recall-dedupe": "off" },
    body: JSON.stringify({ q: "x", containerTag: "t", limit: 1 }),
  });
  expect(await recall(off, {}, app)).toBeNull();
  const busy = await recall(
    new Request("http://guard/v4/profile", { method: "POST", body: "{}" }),
    {},
    app,
  );
  expect(busy.status).toBe(503);
  expect(
    await recall(
      new Request("http://guard/v3/documents", { method: "POST", body: "{}" }),
      {},
      app,
    ),
  ).toBeNull();
  expect(
    await recall(
      new Request("http://guard/v4/search", {
        method: "POST",
        body: "not json",
      }),
      {},
      app,
    ),
  ).toBeNull();
});

const rpc = (body, headers = { Authorization: "Bearer good" }) =>
  new Request("http://guard/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function mcpApp(extra = {}) {
  return fakeApp({
    "GET /v3/session": (call) =>
      call.auth === "Bearer good"
        ? sessionOk()
        : [401, { error: "Unauthorized" }],
    ...extra,
  });
}

test("/mcp refuses requests without a valid key, and checks it through the API", async () => {
  const app = mcpApp();
  expect(
    (await mcp(rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, {}), {}, app))
      .status,
  ).toBe(401);
  const bad = await mcp(
    rpc(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { Authorization: "Bearer wrong" },
    ),
    {},
    app,
  );
  expect(bad.status).toBe(401);
  expect(app.calls.at(-1)).toMatchObject({
    path: "/v3/session",
    host: "factory-supermemory.internal",
    auth: "Bearer wrong",
  });
});

test("/mcp initialize, notifications, ping and tool listing", async () => {
  const app = mcpApp();
  const init = await mcp(
    rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    }),
    {},
    app,
  );
  expect(init.status).toBe(200);
  expect(init.headers.get("mcp-session-id")).toBeTruthy();
  const result = (await init.json()).result;
  expect(result.protocolVersion).toBe("2025-03-26");
  expect(result.capabilities.tools).toBeDefined();
  const unknownVersion = await mcp(
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    }),
    {},
    app,
  );
  expect((await unknownVersion.json()).result.protocolVersion).toBe(
    "2025-06-18",
  );
  const note = await mcp(
    rpc({ jsonrpc: "2.0", method: "notifications/initialized" }),
    {},
    app,
  );
  expect(note.status).toBe(202);
  expect(await note.text()).toBe("");
  expect(
    (
      await (
        await mcp(rpc({ jsonrpc: "2.0", id: 3, method: "ping" }), {}, app)
      ).json()
    ).result,
  ).toEqual({});
  const list = await (
    await mcp(rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" }), {}, app)
  ).json();
  const names = list.result.tools.map((t) => t.name);
  expect(names).toEqual([
    "search_memory",
    "add_memory",
    "listSpaces",
    "listMemories",
    "getDocument",
    "whoAmI",
  ]);
  expect(
    list.result.tools.every(
      (t) => t.inputSchema?.type === "object" && !("run" in t),
    ),
  ).toBe(true);
  expect(
    TOOLS.find((t) => t.name === "add_memory").annotations.readOnlyHint,
  ).toBe(false);
});

test("search_memory searches one tag with the caller's key and returns distinct memories", async () => {
  const app = mcpApp({
    "POST /v4/search": () => [
      200,
      {
        results: [...reworded, other].map((memory, i) => ({
          memory,
          similarity: 0.8 - i / 20,
          updatedAt: "2026-11-03T01:00:00Z",
        })),
      },
    ],
  });
  const reply = await (
    await mcp(
      rpc({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "search_memory",
          arguments: { query: "port", containerTag: "repo_x__1", limit: 3 },
        },
      }),
      {},
      app,
    )
  ).json();
  const text = reply.result.content[0].text;
  expect(reply.result.isError).toBeUndefined();
  expect(text).toContain("2 memories from supermemory in repo_x__1");
  expect(text).toContain(fact);
  expect(text).toContain(other);
  expect(text).not.toContain(reworded[1]);
  const search = app.calls.find((c) => c.path === "/v4/search");
  expect(search).toMatchObject({
    auth: "Bearer good",
    host: "factory-supermemory.internal",
  });
  expect(search.body).toEqual({
    q: "port",
    containerTag: "repo_x__1",
    limit: 9,
  });
});

test("search_memory follows the server's FACTORY_RECALL_DEDUPE=off", async () => {
  const app = mcpApp({
    "POST /v4/search": () => [
      200,
      { results: reworded.map((memory) => ({ memory })) },
    ],
  });
  const before = process.env.FACTORY_RECALL_DEDUPE;
  process.env.FACTORY_RECALL_DEDUPE = "off";
  try {
    const reply = await (
      await mcp(
        rpc({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "search_memory",
            arguments: { query: "port", containerTag: "t", limit: 3 },
          },
        }),
        {},
        app,
      )
    ).json();
    expect(reply.result.content[0].text).toContain("3 memories");
    expect(app.calls.find((c) => c.path === "/v4/search").body.limit).toBe(3);
  } finally {
    if (before === undefined) delete process.env.FACTORY_RECALL_DEDUPE;
    else process.env.FACTORY_RECALL_DEDUPE = before;
  }
});

test("MCP tools call the server path they are given, not upstream directly", async () => {
  const app = mcpApp();
  const seen = [];
  // Stands in for IngestionQueue.fetch, which reports a pending append as "queued".
  const server = async (request) => {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    seen.push(route);
    if (route === "GET /v3/documents/doc1")
      return Response.json({ id: "doc1", status: "queued", content: "x" });
    return app.fetch(request);
  };
  const reply = await (
    await recall(
      rpc({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "getDocument", arguments: { id: "doc1" } },
      }),
      {},
      app,
      server,
    )
  ).json();
  expect(reply.result.content[0].text).toContain("Document doc1 (queued)");
  expect(seen).toEqual(["GET /v3/session", "GET /v3/documents/doc1"]);
});

test("tools report bad input as tool errors, and unknown names as protocol errors", async () => {
  const app = mcpApp();
  const call = async (name, args) =>
    await (
      await mcp(
        rpc({
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name, arguments: args },
        }),
        {},
        app,
      )
    ).json();
  const noTag = await call("search_memory", { query: "x" });
  expect(noTag.result.isError).toBe(true);
  expect(noTag.result.content[0].text).toContain("containerTag is required");
  expect(
    (await call("search_memory", { containerTag: "t" })).result.isError,
  ).toBe(true);
  expect((await call("getDocument", { id: "../etc" })).result.isError).toBe(
    true,
  );
  expect((await call("nope", {})).error.code).toBe(-32602);
  const unknown = await (
    await mcp(rpc({ jsonrpc: "2.0", id: 7, method: "resources/list" }), {}, app)
  ).json();
  expect(unknown.error.code).toBe(-32601);
  expect((await mcp(rpc("{not json"), {}, app)).status).toBe(400);
  const invalid = await (
    await mcp(rpc({ id: 8, method: "ping" }), {}, app)
  ).json();
  expect(invalid.error.code).toBe(-32600);
});

test("add_memory, listSpaces, listMemories, getDocument and whoAmI go through the API", async () => {
  const app = mcpApp({
    "POST /v3/documents": () => [200, { id: "doc1", status: "queued" }],
    "GET /v3/container-tags/list": () => [
      200,
      [
        { containerTag: "repo_x__1", description: "x repo" },
        { containerTag: "nick" },
      ],
    ],
    "POST /v4/memories/list": () => [
      200,
      {
        memoryEntries: [
          { memory: fact, createdAt: "2026-11-03T00:00:00Z" },
          { memory: "gone", isForgotten: true },
        ],
      },
    ],
    "GET /v3/documents/doc1": () => [
      200,
      {
        id: "doc1",
        status: "done",
        containerTags: ["repo_x__1"],
        content: "hello",
        createdAt: "2026-11-03T00:00:00Z",
      },
    ],
  });
  const call = async (name, args) =>
    (
      await (
        await mcp(
          rpc({
            jsonrpc: "2.0",
            id: 9,
            method: "tools/call",
            params: { name, arguments: args },
          }),
          {},
          app,
        )
      ).json()
    ).result.content[0].text;
  expect(
    await call("add_memory", {
      content: "remember this",
      containerTag: "repo_x__1",
    }),
  ).toContain("document doc1");
  const add = app.calls.find((c) => c.path === "/v3/documents");
  expect(add.body).toMatchObject({
    content: "remember this",
    containerTag: "repo_x__1",
    metadata: { sm_source: "mcp", type: "manual_memory" },
  });
  expect(await call("listSpaces", { query: "repo" })).toBe(
    "- repo_x__1: x repo",
  );
  const memories = await call("listMemories", {
    containerTag: "repo_x__1",
    limit: 500,
  });
  expect(memories).toContain(fact);
  expect(memories).not.toContain("gone");
  expect(app.calls.find((c) => c.path === "/v4/memories/list").body.limit).toBe(
    50,
  );
  expect(await call("getDocument", { id: "doc1" })).toContain("hello");
  expect(await call("getDocument", { id: "missing" })).toBe(
    "No document missing.",
  );
  const who = await call("whoAmI", {});
  expect(who).toContain('organization "Local"');
  expect(who).not.toContain("secret-session");
});

test("/mcp answers batches, refuses GET and accepts session ends", async () => {
  const app = mcpApp();
  const batch = await mcp(
    rpc([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]),
    {},
    app,
  );
  const replies = await batch.json();
  expect(replies.map((r) => r.id)).toEqual([1, 2]);
  expect((await mcp(new Request("http://guard/mcp"), {}, app)).status).toBe(
    405,
  );
  expect(
    (await mcp(new Request("http://guard/mcp", { method: "DELETE" }), {}, app))
      .status,
  ).toBe(204);
  const routed = await recall(
    rpc({ jsonrpc: "2.0", id: 3, method: "ping" }),
    {},
    app,
  );
  expect((await routed.json()).result).toEqual({});
});
