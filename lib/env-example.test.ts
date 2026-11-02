import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;

// Read inside @foritllc/auth, not in this repo's source.
const PACKAGE_READS = ["SESSION_SECRET"];
// Set by App Service or Next.js itself; nobody configures them.
const PLATFORM_SET = ["IDENTITY_ENDPOINT", "IDENTITY_HEADER", "WEBSITE_HOSTNAME", "NEXT_PHASE", "NODE_ENV"];
// Read by prefix: EMAIL_UNSUBSCRIBE_KEY_<ID>, one per signing key.
const PREFIXES = ["EMAIL_UNSUBSCRIBE_KEY_"];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

function readByCode(): Set<string> {
  const files = [...sources(join(root, "app")), ...sources(join(root, "lib")), join(root, "middleware.ts"), join(root, "next.config.mjs")];
  const names = new Set<string>();
  for (const file of files) {
    for (const m of readFileSync(file, "utf8").matchAll(/\benv\.([A-Z][A-Z0-9_]+)|process\.env\[["']([A-Z][A-Z0-9_]+)["']\]/g)) names.add((m[1] ?? m[2])!);
  }
  for (const name of PACKAGE_READS) names.add(name);
  for (const name of PLATFORM_SET) names.delete(name);
  return names;
}

function listedInExample(): Set<string> {
  const names = new Set<string>();
  for (const m of readFileSync(join(root, ".env.example"), "utf8").matchAll(/^(?:# )?([A-Z][A-Z0-9_]+)=/gm)) names.add(m[1]!);
  return names;
}

const byPrefix = (name: string) => PREFIXES.some((p) => name.startsWith(p));

test(".env.example lists every setting the app reads, and nothing it doesn't", () => {
  const read = readByCode();
  const listed = listedInExample();
  assert.deepEqual([...read].filter((n) => !listed.has(n)).sort(), [], "read by the app but missing from .env.example");
  assert.deepEqual([...listed].filter((n) => !read.has(n) && !byPrefix(n)).sort(), [], "in .env.example but read by nothing");
  for (const prefix of PREFIXES) assert.ok([...listed].some((n) => n.startsWith(prefix)), `an example ${prefix}<ID> line`);
});

test("the unsubscribe key lines stay commented out, so a copied file never names a key with no value", () => {
  const example = readFileSync(join(root, ".env.example"), "utf8");
  assert.doesNotMatch(example, /^EMAIL_UNSUBSCRIBE_(KEY_[A-Z0-9_]+|CURRENT_KEY)=/m);
});
