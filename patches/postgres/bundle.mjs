import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { patchBinary, pins, sha } from "./patch-binary.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeFiles = [
  "runtime.mjs",
  "ingestion-queue.mjs",
  "workflow-outbox.mjs",
  "launch.sh",
  "pins.json",
];
function inventory(root, relative = "") {
  const files = [];
  for (const item of fs.readdirSync(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const name = relative ? `${relative}/${item.name}` : item.name;
    if (item.isDirectory()) files.push(...inventory(root, name));
    else if (item.isFile()) files.push(name);
    else
      throw new Error("Only regular files/directories are allowed in a bundle");
  }
  return files.sort();
}
export function verifyManifest(root) {
  const files = inventory(root).filter((name) => name !== "runtime.sha256");
  const entries = new Map();
  for (const line of fs
    .readFileSync(path.join(root, "runtime.sha256"), "utf8")
    .trimEnd()
    .split("\n")) {
    const match = /^([a-f0-9]{64})  \.\/([a-zA-Z0-9._/-]+)$/.exec(line);
    if (!match) throw new Error("Invalid checksum manifest");
    const [, digest, name] = match;
    if (
      name.startsWith("/") ||
      name.split("/").some((s) => !s || s === "." || s === "..") ||
      entries.has(name)
    )
      throw new Error("Unsafe or duplicate manifest entry");
    entries.set(name, digest);
  }
  if (files.length !== entries.size || files.some((name) => !entries.has(name)))
    throw new Error("Bundle inventory differs from its manifest");
  for (const [name, digest] of entries)
    if (sha(fs.readFileSync(path.join(root, name))) !== digest)
      throw new Error(`Checksum mismatch: ${name}`);
  return files;
}
export function verifyBundle(root) {
  const files = verifyManifest(root);
  const metadata = JSON.parse(
    fs.readFileSync(path.join(root, "bundle.json"), "utf8"),
  );
  if (
    metadata.patchId !== pins.patchId ||
    typeof metadata.testProbe !== "boolean"
  )
    throw new Error("Unknown bundle format");
  const expected = [
    ...runtimeFiles,
    "launcher.sha256",
    "bundle.json",
    `bin/${pins.binaryName}`,
    ...(metadata.testProbe ? ["runtime-probe.mjs"] : []),
  ].sort();
  if (JSON.stringify(files) !== JSON.stringify(expected))
    throw new Error("Unexpected runtime files");
  if (
    JSON.stringify(
      JSON.parse(fs.readFileSync(path.join(root, "pins.json"), "utf8")),
    ) !== JSON.stringify(pins)
  )
    throw new Error("Bundle pins differ from this checkout");
  if (
    sha(fs.readFileSync(path.join(root, "bin", pins.binaryName))) !==
    pins.patchedSha256
  )
    throw new Error("Patched binary checksum mismatch");
  if (
    fs.readFileSync(path.join(root, "launcher.sha256"), "utf8").trim() !==
    pins.launcherSha256
  )
    throw new Error("Launcher pin mismatch");
  return {
    patchId: pins.patchId,
    files: files.length,
    testProbe: metadata.testProbe,
    patchedSha256: pins.patchedSha256,
  };
}
export function buildBundle(
  original,
  launcher,
  destination,
  testProbe = false,
) {
  if (!original || !launcher || !destination || fs.existsSync(destination))
    throw new Error(
      "Supply an original binary, reviewed launcher, and new destination",
    );
  if (sha(fs.readFileSync(original)) !== pins.originalSha256)
    throw new Error("Unknown original binary");
  if (sha(fs.readFileSync(launcher)) !== pins.launcherSha256)
    throw new Error("Unknown launcher");
  fs.mkdirSync(destination, { mode: 0o700 });
  fs.mkdirSync(path.join(destination, "bin"));
  for (const name of [
    ...runtimeFiles,
    ...(testProbe ? ["runtime-probe.mjs"] : []),
  ])
    fs.copyFileSync(
      path.join(here, name),
      path.join(destination, name),
      fs.constants.COPYFILE_EXCL,
    );
  fs.chmodSync(path.join(destination, "launch.sh"), 0o755);
  patchBinary(original, path.join(destination, "bin", pins.binaryName));
  fs.writeFileSync(
    path.join(destination, "launcher.sha256"),
    pins.launcherSha256 + "\n",
  );
  fs.writeFileSync(
    path.join(destination, "bundle.json"),
    JSON.stringify({ patchId: pins.patchId, testProbe }, null, 2) + "\n",
  );
  const manifest = inventory(destination)
    .map(
      (name) =>
        `${sha(fs.readFileSync(path.join(destination, name)))}  ./${name}\n`,
    )
    .join("");
  fs.writeFileSync(path.join(destination, "runtime.sha256"), manifest, {
    flag: "wx",
  });
  return verifyBundle(destination);
}
if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2);
  if (
    mode === "build" &&
    (args.length === 3 || (args.length === 4 && args[3] === "--with-probe"))
  )
    console.log(
      JSON.stringify(
        buildBundle(...args.slice(0, 3), args[3] === "--with-probe"),
      ),
    );
  else if (mode === "verify" && args.length === 1)
    console.log(JSON.stringify(verifyBundle(args[0])));
  else
    throw new Error(
      "Usage: bundle.mjs build ORIGINAL LAUNCHER NEW_DIRECTORY [--with-probe] | verify DIRECTORY",
    );
}
