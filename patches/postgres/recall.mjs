// Recall quality and agent tools for the pinned local server.
//
// 1. Near-duplicate collapsing. Extraction stores one rewording of a fact per session that
//    mentions it, so a top-N search or profile is often one fact repeated. Responses of
//    POST /v4/search and POST /v4/profile keep an item only when its word set overlaps every
//    higher-ranked kept item's by less than NEAR_DUPLICATE (Jaccard). /v4/search over-fetches to
//    still return the requested limit. Opt out per request with `x-factory-recall-dedupe: off`,
//    or for the server with FACTORY_RECALL_DEDUPE=off.
// 2. A minimal MCP endpoint at /mcp (streamable HTTP, JSON responses, stateless). Upstream Lite
//    serves no /mcp, so the Claude plugin's tool server failed and its recall hints named a tool
//    that did not exist. The tools use the plugin's names and act through the server's own
//    authenticated API with the caller's key, never the server's.
import fs from "node:fs";
import { randomUUID } from "node:crypto";

export const NEAR_DUPLICATE = 0.5;
const OVERFETCH = 3;
const MAX_FETCH = 50;
const MAX_TEXT = 1500;
const MAX_DOCUMENT = 20000;
const INTERNAL = "http://factory-supermemory.internal";
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export function wordSet(text) {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) || [],
  );
}

function overlap(a, b) {
  if (!a.size && !b.size) return 1;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

// Keeps order (the server's ranking); drops an item that repeats a kept one. `seed` holds word
// sets that already count as kept (profile: static facts against dynamic ones).
export function distinct(items, textOf = (item) => item, seed = []) {
  const kept = [];
  const sets = [...seed];
  for (const item of items) {
    const words = wordSet(textOf(item));
    if (sets.some((set) => overlap(words, set) >= NEAR_DUPLICATE)) continue;
    kept.push(item);
    sets.push(words);
  }
  return kept;
}

export const resultText = (r) =>
  [r?.memory, r?.chunk, r?.content, r?.text].find(
    (value) => typeof value === "string" && value.trim(),
  ) || "";

export function dedupeSearch(data, limit) {
  if (!Array.isArray(data?.results)) return data;
  const results = distinct(data.results, resultText);
  data.results = Number.isInteger(limit) ? results.slice(0, limit) : results;
  if (typeof data.total === "number") data.total = data.results.length;
  return data;
}

export function dedupeProfile(data) {
  const profile = data?.profile;
  if (profile && typeof profile === "object") {
    let seed = [];
    if (Array.isArray(profile.static)) {
      profile.static = distinct(profile.static);
      seed = profile.static.map(wordSet);
    }
    if (Array.isArray(profile.dynamic))
      profile.dynamic = distinct(profile.dynamic, (x) => x, seed);
  }
  if (Array.isArray(data?.searchResults?.results))
    data.searchResults.results = distinct(
      data.searchResults.results,
      resultText,
    );
  return data;
}

function dedupeEnabled(request) {
  return (
    process.env.FACTORY_RECALL_DEDUPE !== "off" &&
    request.headers.get("x-factory-recall-dedupe") !== "off"
  );
}

function rewrapped(data, response) {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return Response.json(data, { status: response.status, headers });
}

// Returns a Response when this module handles the request, otherwise null.
export async function recall(request, env, app) {
  const url = new URL(request.url);
  if (url.pathname === "/mcp" || url.pathname === "/mcp/")
    return mcp(request, env, app);
  if (request.method !== "POST" || !dedupeEnabled(request)) return null;
  if (url.pathname === "/v4/search") {
    const body = await request
      .clone()
      .json()
      .catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const limit =
      Number.isInteger(body.limit) && body.limit > 0 ? body.limit : undefined;
    let forwarded = request;
    if (limit) {
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      forwarded = new Request(request.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...body,
          limit: Math.min(MAX_FETCH, Math.max(limit, limit * OVERFETCH)),
        }),
      });
    }
    const response = await app.fetch(forwarded, env);
    if (!response.ok) return response;
    const data = await response
      .clone()
      .json()
      .catch(() => null);
    return data ? rewrapped(dedupeSearch(data, limit), response) : response;
  }
  if (url.pathname === "/v4/profile") {
    const response = await app.fetch(request, env);
    if (!response.ok) return response;
    const data = await response
      .clone()
      .json()
      .catch(() => null);
    return data ? rewrapped(dedupeProfile(data), response) : response;
  }
  return null;
}

// ---- MCP

let releaseVersion;
function version() {
  if (releaseVersion) return releaseVersion;
  try {
    releaseVersion = JSON.parse(
      fs.readFileSync("/opt/factory/release.json", "utf8"),
    ).version;
  } catch {}
  return (releaseVersion ||= "0.0.8");
}

function credentials(request) {
  const headers = {};
  const auth = request.headers.get("authorization");
  const key = request.headers.get("x-api-key");
  if (auth) headers.Authorization = auth;
  if (key) headers["x-api-key"] = key;
  return headers;
}

// The internal Host is not a loopback name, so upstream checks the caller's key as usual.
async function api(context, method, route, body) {
  const response = await context.app.fetch(
    new Request(INTERNAL + route, {
      method,
      headers: {
        ...context.credentials,
        Host: "factory-supermemory.internal",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    context.env,
  );
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { ok: response.ok, status: response.status, data, text };
}

const short = (text, max = MAX_TEXT) => {
  const value = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > max ? value.slice(0, max) + "…" : value;
};
const date = (value) => (typeof value === "string" ? value.slice(0, 10) : "");

class ToolError extends Error {}

function needTag(args) {
  const tag =
    typeof args.containerTag === "string" ? args.containerTag.trim() : "";
  if (!tag)
    throw new ToolError(
      "containerTag is required: this server searches one container tag per request. Use listSpaces to find tags.",
    );
  return tag;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function failed(result, what) {
  throw new ToolError(
    `${what} failed: HTTP ${result.status}${result.data?.error ? ` (${short(result.data.error, 200)})` : ""}`,
  );
}

const TAG = {
  type: "string",
  description:
    "Container tag to use, such as a repository's repo_<name>__<hash> or 'nick'. The Claude plugin fills in the current repository's tag when omitted.",
};

export const TOOLS = [
  {
    name: "search_memory",
    title: "Search memories",
    description:
      "Search this self-hosted Supermemory store for memories relevant to a question. Searches one container tag; near-duplicate memories are collapsed. Cite results as coming from supermemory.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to look for, in natural language.",
        },
        containerTag: TAG,
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "How many memories to return (default 8).",
        },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(context, args) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) throw new ToolError("query is required");
      const containerTag = needTag(args);
      const limit = clampInt(args.limit, 1, 20, 8);
      const result = await api(context, "POST", "/v4/search", {
        q: query.slice(0, 1000),
        containerTag,
        limit: Math.min(MAX_FETCH, limit * OVERFETCH),
      });
      if (!result.ok) failed(result, "Search");
      const hits = dedupeSearch(result.data || {}, limit).results || [];
      if (!hits.length)
        return `No memories in ${containerTag} matched "${short(query, 120)}".`;
      const lines = hits.map((r, i) => {
        const score = Number.isFinite(r.similarity)
          ? `[${r.similarity.toFixed(2)}] `
          : "";
        const when = date(r.updatedAt || r.createdAt);
        return `${i + 1}. ${score}${short(resultText(r))}${when ? ` (${when})` : ""}`;
      });
      return `${hits.length} memories from supermemory in ${containerTag} for "${short(query, 120)}":\n${lines.join("\n")}`;
    },
  },
  {
    name: "add_memory",
    title: "Save a memory",
    description:
      "Save a fact, decision or preference to this Supermemory store under a container tag. Extraction turns it into memories within about a minute.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The text to remember, written to stand on its own.",
        },
        containerTag: TAG,
      },
      required: ["content"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async run(context, args) {
      const content =
        typeof args.content === "string" ? args.content.trim() : "";
      if (!content) throw new ToolError("content is required");
      if (content.length > MAX_DOCUMENT)
        throw new ToolError(
          `content is longer than ${MAX_DOCUMENT} characters`,
        );
      const containerTag = needTag(args);
      const result = await api(context, "POST", "/v3/documents", {
        content,
        containerTag,
        metadata: {
          sm_source: "mcp",
          type: "manual_memory",
          timestamp: new Date().toISOString(),
        },
      });
      if (!result.ok) failed(result, "Saving");
      return `Saved to ${containerTag} (document ${result.data?.id ?? "?"}, ${result.data?.status ?? "queued"}).`;
    },
  },
  {
    name: "listSpaces",
    title: "List container tags",
    description:
      "List the container tags (spaces) in this Supermemory store, optionally filtered by a substring.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Only tags containing this text.",
        },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(context, args) {
      const result = await api(context, "GET", "/v3/container-tags/list");
      if (!result.ok) failed(result, "Listing tags");
      const filter =
        typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      const tags = (
        Array.isArray(result.data)
          ? result.data
          : result.data?.containerTags || []
      )
        .filter(
          (t) =>
            !filter ||
            String(t.containerTag ?? t.name ?? "")
              .toLowerCase()
              .includes(filter),
        )
        .slice(0, 200);
      if (!tags.length)
        return filter
          ? `No container tags contain "${filter}".`
          : "This store has no container tags yet.";
      return tags
        .map(
          (t) =>
            `- ${t.containerTag ?? t.name}${t.description ? `: ${short(t.description, 200)}` : ""}`,
        )
        .join("\n");
    },
  },
  {
    name: "listMemories",
    title: "List memories",
    description: "List the newest memories in one container tag.",
    inputSchema: {
      type: "object",
      properties: {
        containerTag: TAG,
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "How many (default 20).",
        },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(context, args) {
      const containerTag = needTag(args);
      const result = await api(context, "POST", "/v4/memories/list", {
        containerTags: [containerTag],
        limit: clampInt(args.limit, 1, 50, 20),
        sort: "createdAt",
        order: "desc",
      });
      if (!result.ok) failed(result, "Listing memories");
      const entries = (result.data?.memoryEntries || []).filter(
        (m) => !m.isForgotten,
      );
      if (!entries.length) return `No memories in ${containerTag}.`;
      return entries
        .map(
          (m) =>
            `- ${short(m.memory)}${m.createdAt ? ` (${date(m.createdAt)})` : ""}`,
        )
        .join("\n");
    },
  },
  {
    name: "getDocument",
    title: "Read a document",
    description:
      "Read one stored document (for example an agent session capture) by its id or customId.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Document id or customId." },
      },
      required: ["id"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(context, args) {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id || !/^[A-Za-z0-9_:.-]{1,200}$/.test(id))
        throw new ToolError("id must be a document id or customId");
      const result = await api(
        context,
        "GET",
        `/v3/documents/${encodeURIComponent(id)}`,
      );
      if (result.status === 404) return `No document ${id}.`;
      if (!result.ok) failed(result, "Reading the document");
      const d = result.data || {};
      return [
        `Document ${d.id} (${d.status ?? "?"}), tags ${(d.containerTags || []).join(", ") || "?"}, created ${date(d.createdAt)}${d.title ? `, "${short(d.title, 120)}"` : ""}.`,
        short(d.content ?? "", MAX_DOCUMENT),
      ].join("\n\n");
    },
  },
  {
    name: "whoAmI",
    title: "Which store is this",
    description:
      "Show which self-hosted Supermemory server and organization this connection uses.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(context) {
      const result = await api(context, "GET", "/v3/session");
      if (!result.ok) failed(result, "Reading the session");
      const org = result.data?.org || {};
      return `Self-hosted Supermemory ${version()} (Lite), organization "${org.name ?? "?"}" (${org.slug ?? org.id ?? "?"}). Search and save work one container tag at a time.`;
    },
  },
];

const jsonRpc = (id, payload) => ({ jsonrpc: "2.0", id, ...payload });

async function dispatch(message, context) {
  if (
    !message ||
    typeof message !== "object" ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string"
  )
    return jsonRpc(message?.id ?? null, {
      error: { code: -32600, message: "Invalid request" },
    });
  const { id, method, params = {} } = message;
  if (id === undefined || id === null) return null; // a notification: nothing to answer
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return jsonRpc(id, {
        result: {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: "supermemory-local",
            title: "Supermemory (self-hosted)",
            version: version(),
          },
          instructions:
            "Self-hosted Supermemory (Lite). Every search and save uses one container tag: a repository's repo_<name>__<hash> tag or 'nick'. Use listSpaces to find tags.",
        },
      });
    }
    case "ping":
      return jsonRpc(id, { result: {} });
    case "tools/list":
      return jsonRpc(id, {
        result: { tools: TOOLS.map(({ run, ...tool }) => tool) },
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool)
        return jsonRpc(id, {
          error: { code: -32602, message: `Unknown tool: ${params?.name}` },
        });
      let args = params?.arguments ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
      try {
        const text = await tool.run(context, args);
        return jsonRpc(id, { result: { content: [{ type: "text", text }] } });
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        return jsonRpc(id, {
          result: {
            content: [{ type: "text", text: error.message }],
            isError: true,
          },
        });
      }
    }
    default:
      return jsonRpc(id, {
        error: { code: -32601, message: `Method not found: ${method}` },
      });
  }
}

export async function mcp(request, env, app) {
  const sessionId = request.headers.get("mcp-session-id");
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.method !== "POST")
    return new Response("This endpoint answers POST requests with JSON", {
      status: 405,
      headers: { Allow: "POST, DELETE" },
    });
  const context = { app, env, credentials: credentials(request) };
  const unauthorized = (status) =>
    Response.json(
      jsonRpc(null, {
        error: { code: -32001, message: "Supermemory API key required" },
      }),
      { status, headers: { "WWW-Authenticate": "Bearer" } },
    );
  if (!Object.keys(context.credentials).length) return unauthorized(401);
  const session = await api(context, "GET", "/v3/session");
  if (!session.ok) return unauthorized(session.status === 403 ? 403 : 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      jsonRpc(null, { error: { code: -32700, message: "Parse error" } }),
      { status: 400 },
    );
  }
  const batch = Array.isArray(body);
  const replies = [];
  let initialize = false;
  for (const message of batch ? body : [body]) {
    if (message?.method === "initialize") initialize = true;
    try {
      const reply = await dispatch(message, context);
      if (reply) replies.push(reply);
    } catch {
      replies.push(
        jsonRpc(message?.id ?? null, {
          error: { code: -32603, message: "Internal error" },
        }),
      );
    }
  }
  const headers = { "Content-Type": "application/json" };
  const id = sessionId || (initialize ? randomUUID() : null);
  if (id) headers["Mcp-Session-Id"] = id;
  if (!replies.length) return new Response(null, { status: 202, headers });
  return new Response(JSON.stringify(batch ? replies : replies[0]), {
    status: 200,
    headers,
  });
}
