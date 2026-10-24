import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MemoryClient, record } from "./client.ts";
import {
  hash,
  newDirectory,
  readJson,
  secret,
  targetIdentity,
  validateSuite,
  writeJson,
} from "./util.ts";
import type { Config, Manifest, Suite } from "./types.ts";

export async function prepare(config: Config, suite: Suite, directory: string) {
  validateSuite(suite);
  if (suite.documents.length > 100)
    throw new Error(
      "Prepare is bounded to 100 documents; explicitly split larger benchmark imports",
    );
  const client = new MemoryClient(
    config.baseUrl,
    secret(config.keyFile),
    config.allowRemote,
  );
  const manifestFile = path.join(directory, "manifest.json");
  let manifest: Manifest;
  if (fs.existsSync(directory)) {
    manifest = readJson<Manifest>(manifestFile);
    if (
      manifest.targetIdentity !== targetIdentity(config) ||
      manifest.suiteHash !== hash(suite) ||
      hash(manifest.deployment) !== hash(config.deployment)
    )
      throw new Error(
        "Cannot resume with changed target, corpus or deployment",
      );
  } else {
    newDirectory(directory);
    const runId = randomUUID().replaceAll("-", "");
    manifest = {
      schema: 1,
      runId,
      suiteHash: hash(suite),
      targetIdentity: targetIdentity(config),
      documents: {},
      prepared: false,
      deployment: config.deployment,
      spaces: Object.fromEntries(
        [...new Set(suite.documents.map((d) => d.space))].map((space) => [
          space,
          `sm_eval_${runId}_${hash(space).slice(0, 12)}`,
        ]),
      ),
    };
    writeJson(manifestFile, manifest);
    writeJson(path.join(directory, "suite.json"), suite);
  }
  if (manifest.prepared) return manifest;
  // Chronological, sequential extraction within each namespace; at most two
  // namespaces in flight. A later update cannot race an older session.
  const spaces = Object.keys(manifest.spaces);
  const worker = async () => {
    while (spaces.length) {
      const space = spaces.shift()!;
      const docs = suite.documents
        .filter((d) => d.space === space)
        .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
      for (const doc of docs) {
        let saved = manifest.documents[doc.id];
        if (saved?.status === "done" || saved?.status === "forgotten") continue;
        const customId = `sm_eval_${manifest.runId}_${hash(doc.id).slice(0, 16)}`;
        if (saved?.status === "sending") {
          // Never blindly repeat an append after an ambiguous POST outcome.
          const existing = await client.request(
            "GET",
            `/v3/documents/${customId}`,
          );
          if (
            record(existing.metadata).eval_run !== manifest.runId ||
            record(existing.metadata).eval_document_id !== doc.id ||
            typeof existing.id !== "string"
          )
            throw new Error(
              "Ambiguous ingest ownership; use a fresh isolated run",
            );
          saved.id = existing.id;
          saved.status = "indexing";
          writeJson(manifestFile, manifest);
        }
        if (!saved) {
          saved = { id: "", customId, status: "sending" };
          manifest.documents[doc.id] = saved;
          writeJson(manifestFile, manifest);
          const response = await client.request("POST", "/v3/documents", {
            content: doc.content,
            customId,
            containerTag: manifest.spaces[space],
            documentDate: doc.date,
            metadata: { eval_run: manifest.runId, eval_document_id: doc.id },
            entityContext:
              "Keep durable facts, decisions, exact identifiers, dates and user preferences. Distinguish current settings from explicitly superseded settings. Preserve the source of each fact.",
          });
          if (typeof response.id !== "string")
            throw new Error("Ingest response omitted document ID");
          saved.id = response.id;
          saved.status = "indexing";
          writeJson(manifestFile, manifest);
        }
        await client.waitForDocument(saved.id);
        saved.status = "done";
        writeJson(manifestFile, manifest);
        console.log(
          JSON.stringify({
            phase: "ingest",
            document: doc.id,
            done: Object.values(manifest.documents).filter(
              (d) => d.status === "done",
            ).length,
            total: suite.documents.length,
          }),
        );
      }
    }
  };
  await Promise.all([worker(), worker()]);
  for (const doc of suite.documents.filter((d) => d.forget)) {
    const saved = manifest.documents[doc.id];
    if (saved.status !== "forgotten") {
      await client.removeOwnedDocument(saved.id, manifest.runId);
      saved.status = "forgotten";
      writeJson(manifestFile, manifest);
    }
  }
  manifest.prepared = true;
  manifest.preparedAt = new Date().toISOString();
  writeJson(manifestFile, manifest);
  return manifest;
}
