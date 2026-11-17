import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Node 20 does not expand test globs; pass the same complete file set explicitly.
function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? testFiles(path) : path.endsWith(".test.ts") ? [path] : [];
  });
}

const files = testFiles("lib").sort();
if (files.length === 0) throw new Error("No lib/**/*.test.ts files found");
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...process.argv.slice(2), ...files], {
  stdio: "inherit",
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
