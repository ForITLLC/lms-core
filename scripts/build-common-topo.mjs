// Builds every forit-Common workspace in dependency (topological) order.
// Run from the forit-Common checkout root:
//   node ../forit-LMS/scripts/build-common-topo.mjs [--dry-run]
//
// forit-Common's own `npm run build --workspaces` is alphabetical, so any
// package that imports a later-alphabet sibling fails tsc with TS2307. The
// deploy workflow used to hand-maintain a pre-build list; every new
// cross-package dep broke it (brand→email, ui→ai, service-auth→azure-func).
// This computes the order from each package.json's @foritllc/* deps instead.
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const pkgsDir = join(process.cwd(), "packages");

const pkgs = new Map(); // name -> { dir, deps: Set<name>, hasBuild }
for (const dir of readdirSync(pkgsDir)) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(pkgsDir, dir, "package.json"), "utf8"));
  } catch {
    continue;
  }
  const deps = new Set(
    [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies]
      .flatMap((d) => Object.keys(d ?? {}))
      .filter((n) => n.startsWith("@foritllc/")),
  );
  pkgs.set(manifest.name, {
    dir,
    deps,
    hasBuild: Boolean(manifest.scripts?.build),
  });
}

// Kahn's algorithm, alphabetical among ready nodes for a stable order.
const order = [];
const pending = new Map(
  [...pkgs].map(([name, p]) => [
    name,
    new Set([...p.deps].filter((d) => pkgs.has(d))),
  ]),
);
while (pending.size > 0) {
  const ready = [...pending].filter(([, deps]) => deps.size === 0).map(([n]) => n).sort();
  if (ready.length === 0) {
    // Dependency cycle — append the remainder alphabetically and let tsc
    // surface the real error rather than dying silently here.
    console.warn(`[build-common-topo] cycle among: ${[...pending.keys()].join(", ")}`);
    order.push(...[...pending.keys()].sort());
    break;
  }
  for (const name of ready) {
    order.push(name);
    pending.delete(name);
    for (const deps of pending.values()) deps.delete(name);
  }
}

for (const name of order) {
  if (!pkgs.get(name).hasBuild) continue;
  console.log(`[build-common-topo] ${name}`);
  if (dryRun) continue;
  execSync(`npm run build --workspace=${name}`, { stdio: "inherit" });
}
