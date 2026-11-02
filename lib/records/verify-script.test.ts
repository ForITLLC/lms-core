import { test } from "node:test";
import assert from "node:assert/strict";
import * as chain from "./chain";
import { vmLoad } from "@/lib/fixtures/fake-grading-db";
import { COURSE, LEARNER_A, LEARNER_A2, recordsWorld, TENANT_A } from "@/lib/fixtures/fake-records-db";

// scripts/verify-training-records.ts: one tenant's chain, by id or slug, with
// an exit code an operator or a scheduled check can act on, and no person's
// details in what it prints.

const SLUGS: Record<string, string> = { "tenant-a": TENANT_A };

async function run(world: ReturnType<typeof recordsWorld>, argv: string[]) {
  const out: string[] = [];
  const lookups: unknown[] = [];
  let exit: number | undefined;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => { done = resolve; });
  const db = {
    queryOne: async (sql: string, params: { arg: string }) => {
      lookups.push(sql.replace(/\s+/g, " ").trim());
      const id = /WHERE Slug = @arg/.test(sql) ? SLUGS[params.arg] : Object.values(SLUGS).find((t) => t === params.arg.toLowerCase());
      return id ? { TenantId: id.toUpperCase() } : null;
    },
  };
  vmLoad(new URL("../../scripts/verify-training-records.ts", import.meta.url), {
    "dotenv/config": {}, "@/lib/db": db, "@/lib/db/training-records": world.records, "@/lib/records/chain": chain,
  }, {
    console: { log: (...a: unknown[]) => out.push(a.join(" ")), error: (...a: unknown[]) => out.push(a.join(" ")) },
    process: { argv: ["node", "verify", ...argv], env: {}, exit: (code: number) => { exit = code; done(); } },
  });
  await finished;
  return { exit, out: out.join("\n"), lookups };
}

test("a whole chain exits 0, by slug or by id; a changed record exits 1 at its Seq; no tenant or no argument exits 2", async () => {
  const world = recordsWorld();
  for (const learnerId of [LEARNER_A, LEARNER_A2, LEARNER_A]) {
    await world.records.appendTrainingRecord(TENANT_A, {
      learnerId, kind: "course_completion", occurredAt: new Date("2026-10-29T10:00:00.000Z"), result: "completed", source: "auto",
      recordedBy: "pilot@example.test", courseId: COURSE, courseTitle: "Principles of Flight",
    });
  }

  for (const arg of ["tenant-a", TENANT_A.toUpperCase()]) {
    const ok = await run(world, [arg]);
    assert.equal(ok.exit, 0, ok.out);
    assert.match(ok.out, new RegExp(`^ok: tenant ${TENANT_A}, 3 records, head Seq 3, hash [0-9a-f]{64}$`));
  }

  world.db.records[1]!.PersonEmail = "someone.else@example.test";
  const broken = await run(world, ["tenant-a"]);
  assert.equal(broken.exit, 1);
  assert.match(broken.out, /^BROKEN: tenant \S+, at Seq 2 \(hash\): /);
  for (const personal of ["Pilot A", "pilot.a", "someone.else", "Principles of Flight"]) assert.equal(broken.out.includes(personal), false, personal);

  assert.equal((await run(world, ["tenant-z"])).exit, 2);
  assert.equal((await run(world, [])).exit, 2);
  assert.equal((await run(world, ["  "])).exit, 2);
  assert.ok(world.db.statements.every((s) => s.params.tenantId === TENANT_A), "the chain is read in the tenant it was asked for");
});
