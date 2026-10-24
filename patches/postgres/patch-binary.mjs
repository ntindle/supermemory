import fs from "node:fs";
import { createHash } from "node:crypto";

export const pins = JSON.parse(
  fs.readFileSync(new URL("./pins.json", import.meta.url), "utf8"),
);
const originalSha = pins.originalSha256;
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const replacement =
  'async function ba2(){let m=await import(process.env.FACTORY_SUPERMEMORY_RUNTIME||"file:///data/postgres/runtime.mjs"),r=await m.open({Pool:T35,drizzle:Mx0,sql:t,dir:_$,track:bQ,key:Jy("factory-postgres-v1"),install:v=>X15(v,(c,o)=>Mx0({client:c,...o})),migrate:QU2,rivet:(i,p)=>p?xJ0(i,p):XJ0().contentIngestion.get([i]).getState(),fatal:()=>void $y("postgres lease lost",1)});Ue0={stop:r.stop};return r.db}';

export function patchBinary(source, destination) {
  if (
    !source ||
    !destination ||
    source === destination ||
    fs.existsSync(destination)
  )
    throw new Error("Supply an original binary and a new output path");
  const bytes = fs.readFileSync(source);
  if (sha(bytes) !== originalSha)
    throw new Error(
      "Only the reviewed upstream 0.0.8 linux-x64 binary is supported",
    );
  const start = bytes.indexOf("async function ba2(){"),
    end = bytes.indexOf("async function Ja2(", start);
  if (
    start !== 312289126 ||
    end - start !== 438 ||
    Buffer.byteLength(replacement) > end - start
  )
    throw new Error("Unexpected upstream initializer layout");
  bytes.fill(32, start, end);
  bytes.write(replacement, start);
  // The compatibility registration flag stays set, but operator-facing status
  // and telemetry must describe the actual backend and must not claim encryption.
  const replace = (before, after) => {
    const at = bytes.indexOf(before),
      width = Buffer.byteLength(before);
    if (
      at < 0 ||
      bytes.indexOf(before, at + 1) >= 0 ||
      Buffer.byteLength(after) > width
    )
      throw new Error("Unexpected upstream status layout");
    bytes.fill(32, at, at + width);
    bytes.write(after, at);
  };
  // Serialize same-session captures inside the real application transaction.
  // A ready document can update immediately; a busy one durably queues text.
  const captureStart = bytes.indexOf("wK2=async($,z,W,O,v,x,P=!1)=>{"),
    captureEnd = bytes.indexOf(",DK2=", captureStart);
  if (
    captureStart < 0 ||
    captureEnd <= captureStart ||
    captureEnd - captureStart > 3000
  )
    throw new Error("Unexpected capture layout");
  const beforeCapture = bytes.subarray(captureStart, captureEnd).toString();
  let afterCapture = beforeCapture
    .replace(
      "P=!1)=>{let X=",
      "P=!1,R)=>{await globalThis.__sm.lock($,W,z);let X=",
    )
    .replace(".execute();", '.for("update").execute();')
    .replace('if(X.length===0)return{action:"continue"};', "")
    .replace(
      'if(!V)return{action:"continue"};',
      "if(!V)return globalThis.__sm.missing(x);",
    )
    .replace(
      'if(V.status!=="done"&&V.status!=="failed")return{action:"skip",docId:V.id,status:V.status};',
      "let k=await globalThis.__sm.capture($,V,z,W,O,v,x,R);if(k)return k;",
    )
    .replace(
      'if(V.status==="failed")return{action:"update",existingData:{id:V.id,metadata:V.metadata,source:V.source,content:V.content,title:V.title}};',
      "",
    )
    .replace(
      "if(v&&V.content===v)",
      'if(V.status!=="failed"&&v&&V.content===v)',
    );
  if (
    !afterCapture.includes("__sm.capture") ||
    !afterCapture.includes('.for("update")')
  )
    throw new Error("Capture hooks were not inserted");
  replace(beforeCapture, afterCapture);
  // Save exact workflow input in the SAME transaction as the document. The
  // queued-capture sentinel bypasses upstream's last-update-only replay queue.
  const upsertStart = bytes.indexOf("V55=($)=>n0(function*(){"),
    upsertEnd = bytes.indexOf(",tK2=N(", upsertStart);
  if (upsertStart < 0 || upsertEnd - upsertStart > 20000)
    throw new Error("Unexpected upsert layout");
  const beforeUpsert = bytes.subarray(upsertStart, upsertEnd).toString();
  let afterUpsert = beforeUpsert
    .replace(
      "wK2(n,a,z.id,F,r,E,T)",
      "wK2(n,a,z.id,F,r,E,T,{...y,__factoryIsReplace:X})",
    )
    .replace(
      'let g=W0.currentStatus;if(!(v==="mcp"||v==="consumer"))',
      'let g=W0.currentStatus;if(g==="deferred")g="queued";else if(!(v==="mcp"||v==="consumer"))',
    )
    .replace(
      /console\.error\("\[Batch\] Validation failed: customId exceeds 255 characters",\{customId:`\$\{h.customId\?\.slice\(0,50\)\}\.\.\.`,length:h.customId.length\}\),/,
      "",
    )
    .replace(
      /console\.warn\(`\[Batch\] Validation failed for item: \$\{S.reason\} \\u2014 \$\{typeof S.details==="string"\?S.details:JSON.stringify\(S.details\)\}`\),/,
      "",
    )
    .replace(
      /if\(Y.length>0\)console.warn\(`\[Batch\] Validation completed: \$\{K.length\} valid, \$\{Y.length\} failed`\);/,
      "",
    );
  const input =
    "{...y,org:z,token:x,source:v,isFullReplace:X,dreaming:q,preserveBrainTags:T,containerTags:F,taskType:H}";
  for (const result of [
    "{docId:P0,shouldContinue:!0,isDuplicate:!1,metadata:v0,existingContent:A.existingData.content}",
    "{docId:C,shouldContinue:!0,isDuplicate:!1,metadata:E}",
  ]) {
    const old = `return${result}`;
    if (!afterUpsert.includes(old))
      throw new Error("Missing workflow staging boundary");
    afterUpsert = afterUpsert.replace(
      old,
      `return await globalThis.__sm.stage(n,${result},${input})`,
    );
  }
  replace(beforeUpsert, afterUpsert);
  // Rivet must use the durable outbox's actor ID on initial dispatch and recovery.
  const rivetStart = bytes.indexOf("y18=()=>{let $=XJ0;"),
    rivetEnd = bytes.indexOf(",Sa0,h18=", rivetStart);
  if (rivetStart < 0 || rivetEnd - rivetStart > 2000)
    throw new Error("Unexpected workflow trigger layout");
  const beforeRivet = bytes.subarray(rivetStart, rivetEnd).toString();
  const afterRivet = beforeRivet
    .replace('typeof z==="string"?z:H37()', "globalThis.__sm.wid(z)")
    .replace(
      "let O=H37();xJ0(O,W.params)",
      "let O=globalThis.__sm.wid(W.params);xJ0(O,W.params)",
    )
    .replace(
      "Rivet workflow scheduling is not accepting new work",
      "Workflow admission closed",
    );
  replace(beforeRivet, afterRivet);
  const retryStart = bytes.indexOf("async function gl($,z,W){"),
    retryEnd = bytes.indexOf("async function ZN2(", retryStart);
  if (retryStart < 0 || retryEnd - retryStart > 1000)
    throw new Error("Unexpected workflow retry layout");
  replace(
    bytes.subarray(retryStart, retryEnd).toString(),
    "async function gl($,z,W){if(J6().features.selfHosted){z=await globalThis.__sm.retry(z);let x=J6().services;return t7(n0(function*(){return(yield*(yield*nY).create(z)).id}).pipe(P4(kW(x.workflowTrigger(),Cx(M1(pW,{getEnv:()=>$}),x.backgroundTasks())))))}let O=W?bc0($,W):0,v=O?W:cR;return(await(O||$.INGEST_CONTENT_WORKFLOW).create({params:{...z,metadata:{...z.metadata,sm_workflow_binding_name:v}}})).id}",
  );
  replace(
    "let c=Promise.resolve(T.fetch(h,P));",
    "let c=globalThis.__sm.fetch(h,P,T);",
  );
  replace(
    "z8(`[serve] ${$} \\u2014 shutting down...`);",
    'globalThis.__sm?.halt();z8("stopping");',
  );
  replace('bp("encrypted local storage",_$)', 'bp("external PostgreSQL",_$)');
  replace(
    "database:`encrypted local storage (${_$})`",
    'database:"external PostgreSQL"',
  );
  replace(
    'function Ec2(){return process.env.PGLITE_DATA_DIR?"embedded-pglite":"external-postgres"}',
    'function Ec2(){return"external-postgres"}',
  );
  replace(
    'console.log(`  DATABASE\n    ${process.env.PGLITE_DATA_DIR?"\\u2713":"\\u2717"} PGlite`)',
    'console.log("  DATABASE\\n    \\u2713 PostgreSQL")',
  );
  if (sha(bytes) !== pins.patchedSha256)
    throw new Error(
      `Patched executable differs from the reviewed output (${sha(bytes)})`,
    );
  fs.writeFileSync(destination, bytes, { flag: "wx", mode: 0o755 });
  return {
    originalSha,
    patchedSha: sha(bytes),
    replacedBytes: end - start,
    bytes: bytes.length,
  };
}
if (import.meta.main)
  console.log(JSON.stringify(patchBinary(...process.argv.slice(2))));
