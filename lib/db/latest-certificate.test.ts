import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Re-certification: a renewal mints a new certificate per cycle and keeps the
// old one, so a standing reader must see only the latest non-revoked cycle.

const flat = (sql: string) => sql.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")");
const source = (file: string) => flat(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"));
const READERS = { "overdue.ts": { latest: 1, guarded: 0 }, "dashboard.ts": { latest: 2, guarded: 1 }, "reporting.ts": { latest: 0, guarded: 3 } };

function enclosingGroup(s: string, at: number) {
  let open = at;
  for (let depth = 0; open >= 0; open--) {
    if (s[open] === ")") depth++;
    else if (s[open] === "(" && depth-- === 0) break;
  }
  let close = at;
  for (let depth = 0; close < s.length; close++) {
    if (s[close] === "(") depth++;
    else if (s[close] === ")" && depth-- === 0) break;
  }
  return { before: s.slice(0, Math.max(open, 0)), group: s.slice(Math.max(open, 0), close + 1) };
}

const latestApply = (a: string) => new RegExp(`^\\(SELECT TOP 1 ${a}\\.IssuedAt, ${a}\\.ExpiresAt FROM lms\\.Certificate ${a} WHERE .*\\b${a}\\.TenantId = @tenantId AND ${a}\\.RevokedAt IS NULL ORDER BY ${a}\\.CycleNo DESC, ${a}\\.IssuedAt DESC, ${a}\\.CertificateId DESC\\)$`);
const noNewerCycle = (a: string) => new RegExp(`NOT EXISTS \\(SELECT 1 FROM lms\\.Certificate newer WHERE newer\\.LearnerId = ${a}\\.LearnerId AND newer\\.CourseId = ${a}\\.CourseId AND newer\\.TenantId = ${a}\\.TenantId AND newer\\.RevokedAt IS NULL AND newer\\.CycleNo > ${a}\\.CycleNo\\)`);

test("no standing reader joins every certificate cycle", () => {
  for (const file of Object.keys(READERS)) {
    assert.doesNotMatch(source(file), /\bJOIN lms\.Certificate\b/, `${file} joins lms.Certificate`);
  }
});

test("every certificate read takes the latest cycle or skips certificates a newer cycle replaced", () => {
  for (const [file, expected] of Object.entries(READERS)) {
    const s = source(file);
    const seen = { latest: 0, guarded: 0 };
    for (const read of s.matchAll(/lms\.Certificate (\w+)/g)) {
      const alias = read[1]!;
      const { before, group } = enclosingGroup(s, read.index!);
      if (alias === "newer") {
        assert.ok(before.endsWith("NOT EXISTS "), `${file}: stray newer read ${group.slice(0, 120)}`);
        assert.match(group, /newer\.CycleNo > \w+\.CycleNo\)$/, `${file}: newer read without a cycle guard`);
      } else if (before.endsWith("OUTER APPLY ") && group.startsWith("(SELECT TOP 1 ")) {
        assert.match(group, latestApply(alias), `${file}: apply does not pick the latest cycle: ${group.slice(0, 160)}`);
        seen.latest++;
      } else {
        assert.match(group, noNewerCycle(alias), `${file}: ${alias} counts every cycle: ${group.slice(0, 160)}`);
        seen.guarded++;
      }
    }
    assert.deepEqual(seen, expected, `${file}: certificate reads moved; update READERS`);
  }
});
