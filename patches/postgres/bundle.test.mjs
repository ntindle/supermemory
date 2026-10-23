import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyManifest, buildBundle } from "./bundle.mjs";
import { patchBinary, sha } from "./patch-binary.mjs";

test("bundle verification rejects mutation, extra files, traversal, and symlinks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-bundle-test-"));
  try {
    fs.writeFileSync(path.join(dir, "runtime.mjs"), "synthetic module");
    const manifest = `${sha(Buffer.from("synthetic module"))}  ./runtime.mjs\n`;
    fs.writeFileSync(path.join(dir, "runtime.sha256"), manifest);
    expect(verifyManifest(dir)).toEqual(["runtime.mjs"]);
    fs.appendFileSync(path.join(dir, "runtime.mjs"), " changed");
    expect(() => verifyManifest(dir)).toThrow("Checksum");
    fs.writeFileSync(path.join(dir, "runtime.mjs"), "synthetic module");
    fs.writeFileSync(path.join(dir, "extra.mjs"), "unexpected");
    expect(() => verifyManifest(dir)).toThrow("inventory");
    fs.unlinkSync(path.join(dir, "extra.mjs"));
    fs.writeFileSync(
      path.join(dir, "runtime.sha256"),
      manifest.replace("./runtime.mjs", "./../runtime.mjs"),
    );
    expect(() => verifyManifest(dir)).toThrow("Unsafe");
    fs.writeFileSync(path.join(dir, "runtime.sha256"), manifest);
    fs.symlinkSync("runtime.mjs", path.join(dir, "link.mjs"));
    expect(() => verifyManifest(dir)).toThrow("regular");
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("unknown binaries cannot create or overwrite a patch or bundle", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-pin-test-"));
  try {
    const original = path.join(dir, "original"),
      output = path.join(dir, "output"),
      bundle = path.join(dir, "bundle");
    fs.writeFileSync(original, "unknown release");
    expect(() => patchBinary(original, output)).toThrow("reviewed");
    expect(fs.existsSync(output)).toBe(false);
    expect(() => buildBundle(original, original, bundle)).toThrow(
      "Unknown original",
    );
    expect(fs.existsSync(bundle)).toBe(false);
    fs.writeFileSync(output, "keep existing file");
    expect(() => patchBinary(original, output)).toThrow("new output");
    expect(fs.readFileSync(output, "utf8")).toBe("keep existing file");
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
