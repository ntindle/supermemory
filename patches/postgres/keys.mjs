import fs from "node:fs";
import path from "node:path";
import { createHash, pbkdf2Sync } from "node:crypto";

// Public obfuscation constant from the pinned upstream release, not a credential.
const MASK = Buffer.from([
  79, 115, 138, 225, 28, 185, 68, 45, 150, 199, 5, 251, 136, 18, 164, 110, 208,
  55, 145, 91, 74, 254, 44, 112, 163, 24, 197, 141, 107, 41, 228, 119,
]);
export function storeKey(dir, salt = "factory-pglite-pages-v1") {
  const id = fs.readFileSync(path.join(dir, "machine-key"), "utf8").trim();
  if (!id.startsWith("persist:"))
    throw new Error(
      "This migration requires the existing persistent machine identity",
    );
  const hash = createHash("sha256").update(id).digest();
  const password = Buffer.from(MASK.map((b, i) => b ^ hash[i]));
  return pbkdf2Sync(password, salt, 100000, 32, "sha256");
}
