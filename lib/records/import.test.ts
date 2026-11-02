import { test } from "node:test";
import assert from "node:assert/strict";
import { LEARNER_A, LEARNER_A2, recordsWorld, TENANT_A, TENANT_B } from "@/lib/fixtures/fake-records-db";
import { verifyChain } from "./chain";
import { MAX_IMPORT_ROWS } from "./import";

// Values made in the modules' own realm (vmLoad) compared by their JSON.
const same = (actual: unknown, expected: unknown, message?: string) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

// Importing paper training records from CSV (slice R2a): a dry run writes
// nothing; a file with any bad row writes nothing; each row is a 'backfill'
// record carrying the file's hash and its row number, so running the same
// file again writes only what is missing; cells are kept as their text.

const NOW = new Date("2026-10-29T12:00:00.000Z");
const HEADER = "email,kind,title,occurred_on,result,evidence_ref,instructor,assessor,failure_detail,score,passing_score,check_type";
const ROWS = [
  "pilot.a@example.test,check,PPC DHC-8,2024-05-02,pass,PFTR 0099,,A. Assessor,,88,80,ppc",
  "PILOT.A2@example.test,ojt,\"OJT, sectors 1-4\",2023-11-20,completed,OJT book 7,I. Instructor,,,,,",
  'pilot.a@example.test,familiarization,"=HYPERLINK(""http://x.test"")",2022-01-15,attended,=1+1,@SUM(A1),,,,,',
];
const csv = (rows: string[] = ROWS) => [HEADER, ...rows].join("\r\n") + "\r\n";
const run = (world: ReturnType<typeof recordsWorld>, text: string, dryRun: boolean, tenantId = TENANT_A) =>
  world.imports.runImport(tenantId, text, { dryRun, recordedBy: "admin@a.test", now: NOW });
const appends = (world: ReturnType<typeof recordsWorld>) => world.db.statements.filter((s) => s.sql.includes("INSERT INTO lms.TrainingRecord (")).length;

test("a dry run checks every row and writes nothing", async () => {
  const world = recordsWorld({ tenants: "tenant-a" });
  const result = await run(world, csv(), true);
  assert.equal(result.outcome, "dry_run");
  assert.equal(result.rows, 3);
  assert.equal(result.wouldWrite, 3);
  assert.equal(result.alreadyWritten, 0);
  same(result.issues, []);
  assert.equal(world.db.records.length, 0);
  assert.equal(appends(world), 0);
  assert.equal(world.db.chain.length, 0);
});

test("an import writes each row as a backfill record of the matched learner, cells verbatim, chained", async () => {
  const world = recordsWorld({ tenants: "tenant-a" });
  const result = await run(world, csv(), false);
  assert.equal(result.outcome, "imported");
  assert.equal(result.written, 3);
  const rows = world.db.records;
  same(rows.map((r) => [r.LearnerId, r.Kind, r.Source, r.RecordedBy]), [
    [LEARNER_A, "check", "backfill", "admin@a.test"],
    [LEARNER_A2, "ojt", "backfill", "admin@a.test"],
    [LEARNER_A, "familiarization", "backfill", "admin@a.test"],
  ]);
  assert.equal(rows[0]!.Score, 88);
  assert.equal(rows[1]!.CourseTitle, "OJT, sectors 1-4");
  assert.equal(rows[2]!.CourseTitle, '=HYPERLINK("http://x.test")');
  const payload = JSON.parse(rows[2]!.PayloadJson);
  assert.equal(payload.evidenceRef, "=1+1");
  assert.equal(payload.instructorName, "@SUM(A1)");
  assert.equal(payload.importId, result.importId);
  assert.equal(payload.importRow, 4);
  assert.match(result.importId, /^[0-9a-f]{64}$/);
  const { rows: chain, head } = await world.records.readChain(TENANT_A);
  assert.equal(verifyChain(chain, head).ok, true);
});

test("one bad row refuses the whole file, and the dry run lists every problem by row and column", async () => {
  const world = recordsWorld({ tenants: "tenant-a" });
  const bad = [
    ...ROWS,
    "pilot.a@example.test,check,Line check,2024-06-01,fail,PFTR 0100,,A. Assessor,,,,line_check",
    "nobody@example.test,ojt,OJT,2024-06-01,completed,Book,I,,,,,",
    "pilot.b@example.test,ojt,OJT,2024-06-01,completed,Book,I,,,,,",
    "pilot.a@example.test,ojt,OJT,2024-06-01,completed,Book,I,,,eighty,,",
    "pilot.a@example.test,ojt,OJT",
  ];
  const dry = await run(world, csv(bad), true);
  assert.equal(dry.outcome, "dry_run");
  assert.equal(dry.wouldWrite, 3);
  same(dry.issues.map((i: { row: number; column: string }) => [i.row, i.column]), [
    [5, "failure_detail"], [6, "email"], [7, "email"], [8, "score"], [9, ""],
  ]);
  const real = await run(world, csv(bad), false);
  assert.equal(real.outcome, "invalid");
  assert.equal(real.issues.length, 5);
  assert.equal(world.db.records.length, 0);
  assert.equal(appends(world), 0);
});

test("another tenant's learner can't be matched, even by an exact email", async () => {
  const world = recordsWorld({ tenants: "tenant-a,tenant-b" });
  const result = await run(world, csv([ROWS[0]!]), false, TENANT_B);
  assert.equal(result.outcome, "invalid");
  assert.equal(result.issues[0].column, "email");
  assert.equal(world.db.records.length, 0);
});

test("running the same file again writes only the rows not yet written", async () => {
  const world = recordsWorld({ tenants: "tenant-a" });
  let calls = 0;
  world.db.faults.before = (sql) => (sql.includes("INSERT INTO lms.TrainingRecord (") && ++calls === 2 ? new Error("connection reset") : undefined);
  const stopped = await run(world, csv(), false);
  assert.equal(stopped.outcome, "stopped");
  assert.equal(stopped.written, 1);
  assert.equal(stopped.stoppedAtRow, 3);
  assert.equal(world.db.records.length, 1);

  world.db.faults.before = undefined;
  const dry = await run(world, csv(), true);
  assert.equal(dry.wouldWrite, 2);
  assert.equal(dry.alreadyWritten, 1);
  const rest = await run(world, csv(), false);
  assert.equal(rest.outcome, "imported");
  assert.equal(rest.written, 2);
  assert.equal(rest.alreadyWritten, 1);
  const again = await run(world, csv(), false);
  assert.equal(again.written, 0);
  assert.equal(again.alreadyWritten, 3);
  same(world.db.records.map((r) => JSON.parse(r.PayloadJson).importRow), [2, 3, 4]);

  const other = await run(world, csv().replace("PFTR 0099", "PFTR 0098"), false);
  assert.equal(other.written, 3, "a changed file is a different import");
});

test("a file that isn't a usable table is refused before anything is read from the database", async () => {
  const world = recordsWorld({ tenants: "tenant-a" });
  const refusals: [string, RegExp][] = [
    ["", /empty/],
    [HEADER + "\n", /no rows/],
    ["email,kind,title,occurred_on,result,evidence_ref,instructor,licence_no\n", /Unknown column "licence_no"/],
    ["email,kind,title,occurred_on,result,instructor\n", /Missing column "evidence_ref"/],
    ["email,kind,title,occurred_on,result,evidence_ref\n", /instructor or an assessor/],
    ["email,email,kind,title,occurred_on,result,evidence_ref,instructor\n", /appears twice/],
    [`${HEADER}\n"unclosed`, /isn't valid CSV/],
    [`${HEADER}\n${"x,".repeat(600_000)}`, /over 1 MB/],
    [[HEADER, ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => ROWS[0]!)].join("\n"), /at most 2000/],
  ];
  for (const [text, message] of refusals) {
    const result = await world.imports.planImport(text, [], NOW);
    assert.equal(result.ok, false);
    assert.match(result.error, message);
  }
  const refused = await run(world, "", false);
  assert.equal(refused.outcome, "refused");
  assert.equal(world.db.records.length, 0);
});

test("headers are matched however they are cased or spaced, and a byte order mark is ignored", async () => {
  const world = recordsWorld({ tenants: "tenant-a" });
  const header = "\uFEFFEmail,Kind,Title,Occurred On,Result,Evidence-Ref,Instructor";
  const result = await run(world, `${header}\npilot.a@example.test,ojt,OJT,2024-06-01,completed,Book 1,I. Instructor\n`, false);
  assert.equal(result.outcome, "imported");
  assert.equal(result.written, 1);
});
