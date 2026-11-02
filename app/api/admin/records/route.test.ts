import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import * as permissions from "@/lib/auth/records-permissions";
import * as roles from "@/lib/auth/roles";
import { vmLoad } from "@/lib/fixtures/fake-grading-db";
import { LEARNER_A, LEARNER_B, recordsWorld, TENANT_A, TENANT_B } from "@/lib/fixtures/fake-records-db";

// The training-record admin routes of slice R2a, over the in-memory
// database: /api/admin/records (GET, POST), /api/admin/records/[recordId]
// (GET), its /corrections (POST), /api/admin/records/import (POST) and
// /api/admin/learners/[learnerId]/personnel (GET, POST). Each asks its own
// right (@/lib/auth/records-permissions) of the session's own tenant, and
// only where that tenant's records are switched on; another tenant's learner
// or record is 404. Card d3e16430 (slice R2b) adds two roles: an instructor
// reads and enters the training it runs or assesses; a training manager also
// corrects and imports; personnel stays the admin's.

type Session = { tenantId?: string; email: string; role?: string } | null;
const ADMIN_A = { tenantId: TENANT_A, email: "admin@a.test", role: "admin" };
const ADMIN_B = { tenantId: TENANT_B, email: "admin@b.test", role: "admin" };
const INSTRUCTOR_A = { tenantId: TENANT_A, email: "instructor@a.test", role: "instructor" };
const MANAGER_A = { tenantId: TENANT_A, email: "manager@a.test", role: "training_manager" };
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const root = (path: string) => new URL(`../../../../${path}`, import.meta.url);

const CHECK = {
  kind: "check", title: "PPC, DHC-8", occurredOn: "2026-10-01", result: "pass", checkType: "ppc",
  assessorName: "A. Assessor", evidenceRef: "PFTR 2026-0412",
};
const CSV = [
  "email,kind,title,occurred_on,result,evidence_ref,instructor",
  "pilot.a@example.test,ojt,Line OJT,2024-05-02,completed,OJT book 3,I. Instructor",
  "pilot.a2@example.test,familiarization,DHC-8 fam,2023-02-01,attended,Paper file 12,I. Instructor",
].join("\n");

function load(session: Session = ADMIN_A, tenants = "tenant-a,tenant-b", rights: Record<string, unknown> = permissions) {
  const world = recordsWorld({ tenants });
  const runs: unknown[][] = [];
  const errors: unknown[][] = [];
  const logging = { recordServiceRun: async (...a: unknown[]) => { runs.push(a); }, recordError: async (...a: unknown[]) => { errors.push(a); } };
  const gate = vmLoad(root("lib/auth/staff-gate.ts"), {
    "@/lib/get-session": { getSessionUser: async () => session }, "@/lib/auth/roles": roles, "@/lib/logging": logging,
  });
  const recordsGate = vmLoad(root("lib/records/gate.ts"), { "@/lib/auth/staff-gate": gate, "./switch": world.recordsSwitch });
  const modules = {
    zod: { z }, "@/lib/auth/staff-gate": gate, "@/lib/records/gate": recordsGate, "@/lib/auth/records-permissions": rights, "@/lib/logging": logging,
    "@/lib/db/training-records": world.records, "@/lib/db/personnel-links": world.personnelLinks,
    "@/lib/records/corrections": world.corrections, "@/lib/records/manual": world.manual,
    "@/lib/records/personnel": world.personnel, "@/lib/records/import": world.imports,
  };
  const records = vmLoad(root("app/api/admin/records/route.ts"), modules);
  const one = vmLoad(root("app/api/admin/records/[recordId]/route.ts"), modules);
  const corrections = vmLoad(root("app/api/admin/records/[recordId]/corrections/route.ts"), modules);
  const imports = vmLoad(root("app/api/admin/records/import/route.ts"), modules);
  const personnel = vmLoad(root("app/api/admin/learners/[learnerId]/personnel/route.ts"), modules);

  const url = (path: string) => `https://a.example${path}`;
  const json = (method: string, path: string, body: unknown) =>
    new Request(url(path), { method, headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const api = {
    learners: () => records.GET(new Request(url("/api/admin/records"))) as Promise<Response>,
    learnerRecords: (id: string) => records.GET(new Request(url(`/api/admin/records?learnerId=${id}`))) as Promise<Response>,
    enter: (body: unknown) => records.POST(json("POST", "/api/admin/records", body)) as Promise<Response>,
    line: (id: string) => one.GET(new Request(url(`/api/admin/records/${id}`)), { params: Promise.resolve({ recordId: id }) }) as Promise<Response>,
    correct: (id: string, body: unknown) =>
      corrections.POST(json("POST", `/api/admin/records/${id}/corrections`, body), { params: Promise.resolve({ recordId: id }) }) as Promise<Response>,
    import: (text: string, dryRun: boolean, type = "text/csv") =>
      imports.POST(new Request(url(`/api/admin/records/import${dryRun ? "?dryRun=1" : ""}`), { method: "POST", headers: { "Content-Type": type }, body: text })) as Promise<Response>,
    personnel: (id: string) => personnel.GET(new Request(url(`/api/admin/learners/${id}/personnel`)), { params: Promise.resolve({ learnerId: id }) }) as Promise<Response>,
    addPersonnel: (id: string, body: unknown) =>
      personnel.POST(json("POST", `/api/admin/learners/${id}/personnel`, body), { params: Promise.resolve({ learnerId: id }) }) as Promise<Response>,
  };
  const every = () => [
    api.learners(), api.learnerRecords(LEARNER_A), api.enter({ learnerId: LEARNER_A, ...CHECK }), api.line(LEARNER_A),
    api.correct(LEARNER_A, { reason: "x", void: true }), api.import(CSV, true), api.personnel(LEARNER_A),
    api.addPersonnel(LEARNER_A, { dutyPosition: "pilot", effectiveFrom: "2025-01-01" }),
  ];
  return { world, api, every, runs, errors };
}

test("signed out is 401, no tenant is 400, a learner or an author is 403, on every route, and nothing is read", async () => {
  for (const [session, status] of [
    [null, 401],
    [{ email: "x@a.test", role: "admin" }, 400],
    [{ tenantId: TENANT_A, email: "x@a.test", role: "learner" }, 403],
    [{ tenantId: TENANT_A, email: "x@a.test", role: "author" }, 403],
  ] as const) {
    const app = load(session);
    for (const res of await Promise.all(app.every())) assert.equal(res.status, status, JSON.stringify(session));
    assert.deepEqual(app.world.db.statements, []);
  }
});

test("each route asks its own right: withholding one right refuses exactly its routes, before anything is read", async () => {
  const RIGHT_OF_EVERY = [
    "canReadRecords", "canReadRecords", "canWriteRecords", "canReadRecords",
    "canCorrectRecords", "canImportRecords", "canManagePersonnel", "canManagePersonnel",
  ];
  for (const withheld of new Set(RIGHT_OF_EVERY)) {
    const app = load(ADMIN_A, "tenant-a,tenant-b", { ...permissions, [withheld]: () => false });
    const statuses = (await Promise.all(app.every())).map((res) => res.status);
    RIGHT_OF_EVERY.forEach((right, i) => {
      if (right === withheld) assert.equal(statuses[i], 403, `${withheld}: route ${i}`);
      else assert.notEqual(statuses[i], 403, `${withheld}: route ${i} doesn't need it`);
    });
  }
});

test("where the tenant's records are off, every route is 404 for its admin and nothing is read or written", async () => {
  for (const tenants of ["", "tenant-b"]) {
    const app = load(ADMIN_A, tenants);
    for (const res of await Promise.all(app.every())) {
      assert.equal(res.status, 404, String(tenants));
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
    assert.deepEqual(app.world.db.statements, []);
    assert.deepEqual(app.runs, []);
  }
});

test("the learner list is the admin's own tenant's, left learners included", async () => {
  const res = await load().api.learners();
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).learners.map((l: { email: string; status: string }) => [l.email, l.status]), [
    ["pilot.a@example.test", "active"], ["pilot.a2@example.test", "left"],
  ]);
});

test("an admin enters a record, sees it in force, corrects it with a reason, and sees the whole line", async () => {
  const app = load();
  const entered = await app.api.enter({ learnerId: LEARNER_A.toUpperCase(), ...CHECK });
  assert.equal(entered.status, 201);
  const { record } = await entered.json();
  assert.equal(record.source, "manual");
  assert.equal(record.recordedBy, "admin@a.test");
  assert.equal(record.learnerId, LEARNER_A);

  const corrected = await app.api.correct(record.recordId, { reason: "The check flew on the 2nd.", changes: { occurredOn: "2026-10-02" } });
  assert.equal(corrected.status, 201);
  const fix = (await corrected.json()).record;
  assert.equal(fix.correctsRecordId, record.recordId);
  assert.equal(fix.details.correctionReason, "The check flew on the 2nd.");

  const inForce = await (await app.api.learnerRecords(LEARNER_A)).json();
  assert.deepEqual(inForce.records.map((r: { recordId: string }) => r.recordId), [fix.recordId]);
  const line = await (await app.api.line(record.recordId)).json();
  assert.deepEqual(line.line.map((r: { recordId: string; occurredAt: string }) => [r.recordId, r.occurredAt.slice(0, 10)]), [
    [record.recordId, "2026-10-01"], [fix.recordId, "2026-10-02"],
  ]);
  assert.equal(line.currentRecordId, fix.recordId);

  const stale = await app.api.correct(record.recordId, { reason: "Again", changes: { title: "x" } });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).currentRecordId, fix.recordId);
  assert.deepEqual(plain(app.runs.map((r) => [r[0], r[1], r[3]])), [["lms-records", "SUCCESS", 1], ["lms-records", "SUCCESS", 1]]);
  assert.equal(app.world.db.records.length, 2);
});

test("a fail with no detail is 422 with the field; a bad correction body is 400; nothing is written", async () => {
  const app = load();
  const fail = await app.api.enter({ learnerId: LEARNER_A, ...CHECK, result: "fail" });
  assert.equal(fail.status, 422);
  assert.deepEqual((await fail.json()).issues.map((i: { field: string }) => i.field), ["failureDetail"]);
  assert.equal((await app.api.enter("not json")).status, 400);
  const record = (await (await app.api.enter({ learnerId: LEARNER_A, ...CHECK })).json()).record;
  for (const body of [{ changes: { title: "x" } }, { reason: " ", void: true }, { reason: "x", void: false }, { reason: "x", changes: { licenceNo: "1" } }]) {
    assert.equal((await app.api.correct(record.recordId, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await app.api.correct(record.recordId, { reason: "x", changes: { result: "fail" } })).status, 422);
  assert.equal(app.world.db.records.length, 1);
});

test("another tenant's learner or record is 404, as if it didn't exist, and is left untouched", async () => {
  const app = load(ADMIN_B);
  assert.equal((await app.api.enter({ learnerId: LEARNER_A, ...CHECK })).status, 404);
  assert.equal((await app.api.learnerRecords(LEARNER_A)).status, 404);
  assert.equal((await app.api.personnel(LEARNER_A)).status, 404);
  assert.equal((await app.api.addPersonnel(LEARNER_A, { dutyPosition: "pilot", effectiveFrom: "2025-01-01" })).status, 404);

  const a = load();
  const record = (await (await a.api.enter({ learnerId: LEARNER_A, ...CHECK })).json()).record;
  const b = load(ADMIN_B);
  b.world.db.records.push(...a.world.db.records);
  b.world.db.chain.push(...a.world.db.chain);
  assert.equal((await b.api.line(record.recordId)).status, 404);
  assert.equal((await b.api.correct(record.recordId, { reason: "x", void: true })).status, 404);
  assert.equal(b.world.db.records.length, 1);
  for (const id of ["not-a-uuid", "../x"]) {
    assert.equal((await b.api.line(id)).status, 404);
    assert.equal((await b.api.learnerRecords(id)).status, 404);
  }
  assert.equal((await b.api.learnerRecords(LEARNER_B)).status, 200);
});

test("an import is checked by a dry run, then written; a second run writes nothing more", async () => {
  const app = load();
  const dry = await app.api.import(CSV, true);
  assert.equal(dry.status, 200);
  assert.deepEqual((({ outcome, rows, wouldWrite, alreadyWritten }) => ({ outcome, rows, wouldWrite, alreadyWritten }))(await dry.json()), {
    outcome: "dry_run", rows: 2, wouldWrite: 2, alreadyWritten: 0,
  });
  assert.equal(app.world.db.records.length, 0);
  assert.deepEqual(app.runs, []);

  const real = await app.api.import(CSV, false);
  assert.equal(real.status, 200);
  assert.equal((await real.json()).written, 2);
  assert.deepEqual(app.world.db.records.map((r) => r.Source), ["backfill", "backfill"]);
  const again = await (await app.api.import(CSV, false)).json();
  assert.deepEqual([again.written, again.alreadyWritten], [0, 2]);
  assert.deepEqual(plain(app.runs.map((r) => [r[0], r[3]])), [["lms-records", 2], ["lms-records", 0]]);
});

test("an import with a bad row is 422 and writes nothing; a bad file or type is refused; a stop says how far it got", async () => {
  const app = load();
  const bad = await app.api.import(`${CSV}\npilot.b@example.test,ojt,OJT,2024-01-01,completed,Book,I`, false);
  assert.equal(bad.status, 422);
  const body = await bad.json();
  assert.equal(body.outcome, "invalid");
  assert.deepEqual(body.issues.map((i: { row: number; column: string }) => [i.row, i.column]), [[4, "email"]]);
  assert.equal((await app.api.import("nonsense,header\n1,2", false)).status, 422);
  assert.equal((await app.api.import(CSV, false, "application/json")).status, 415);
  assert.equal(app.world.db.records.length, 0);

  let appends = 0;
  app.world.db.faults.before = (sql) => (sql.includes("INSERT INTO lms.TrainingRecord (") && ++appends === 2 ? new Error("Server=prod;Password=hunter2") : undefined);
  const stopped = await app.api.import(CSV, false);
  assert.equal(stopped.status, 500);
  const report = await stopped.json();
  assert.deepEqual([report.outcome, report.written, report.stoppedAtRow], ["stopped", 1, 3]);
  assert.doesNotMatch(JSON.stringify(report), /hunter2/);
  assert.equal(app.errors.length, 1);
  assert.doesNotMatch(JSON.stringify(app.errors), /OJT book|pilot\.a/, "the log names the import, never the file's contents");
});

test("personnel rows are added and superseded once, and the one in force comes back", async () => {
  const app = load();
  const first = await app.api.addPersonnel(LEARNER_A, { dutyPosition: "pilot", employeeNo: "E100", effectiveFrom: "2025-01-01" });
  assert.equal(first.status, 201);
  const link = (await first.json()).link;
  const fix = { dutyPosition: "dispatcher", effectiveFrom: "2025-01-01", supersedesLinkId: link.personnelLinkId, reason: "Wrong position." };
  assert.equal((await app.api.addPersonnel(LEARNER_A, fix)).status, 201);
  assert.equal((await app.api.addPersonnel(LEARNER_A, fix)).status, 409);
  assert.equal((await app.api.addPersonnel(LEARNER_A, { dutyPosition: "pilot", effectiveFrom: "2025-01-01", supersedesLinkId: link.personnelLinkId })).status, 422);
  const got = await (await app.api.personnel(LEARNER_A)).json();
  assert.equal(got.links.length, 2);
  assert.equal(got.current.dutyPosition, "dispatcher");
  assert.equal(got.current.supersedesLinkId, link.personnelLinkId);
});

test("an instructor reads the records and enters a check as itself, and is refused corrections, imports and personnel", async () => {
  const app = load(INSTRUCTOR_A);
  assert.equal((await app.api.learners()).status, 200);
  const entered = await app.api.enter({ learnerId: LEARNER_A, ...CHECK });
  assert.equal(entered.status, 201);
  const { record } = await entered.json();
  assert.equal(record.recordedBy, "instructor@a.test");
  assert.equal(record.source, "manual");
  for (const kind of ["ojt", "line_indoc", "familiarization", "monitor", "vendor_training"]) {
    const res = await app.api.enter({ learnerId: LEARNER_A, kind, title: `An ${kind}`, occurredOn: "2026-09-01", result: "completed", instructorName: "I. Instructor", evidenceRef: "Book 1" });
    assert.equal(res.status, 201, kind);
  }
  assert.equal((await app.api.learnerRecords(LEARNER_A)).status, 200);
  assert.equal((await app.api.line(record.recordId)).status, 200);

  const written = app.world.db.records.length;
  assert.equal(written, 6);
  for (const res of [
    await app.api.correct(record.recordId, { reason: "x", void: true }),
    await app.api.import(CSV, true),
    await app.api.import(CSV, false),
    await app.api.personnel(LEARNER_A),
    await app.api.addPersonnel(LEARNER_A, { dutyPosition: "pilot", effectiveFrom: "2025-01-01" }),
  ]) assert.equal(res.status, 403);
  assert.equal(app.world.db.records.length, written);
});

test("an instructor can't enter a qualification or an ACP PPC: 403 kind_not_allowed before anything is checked or written", async () => {
  const app = load(INSTRUCTOR_A);
  for (const kind of ["qualification", "acp_ppc"]) {
    for (const body of [
      { learnerId: LEARNER_A, kind, title: "Type rating", occurredOn: "2026-09-01", result: "pass", assessorName: "A. Assessor", evidenceRef: "Cert 9" },
      { learnerId: LEARNER_A, kind },
    ]) {
      const res = await app.api.enter(body);
      assert.equal(res.status, 403, kind);
      assert.equal((await res.json()).code, "kind_not_allowed");
    }
  }
  assert.equal(app.world.db.records.length, 0);
  assert.deepEqual(app.runs, []);

  const unknown = await app.api.enter({ learnerId: LEARNER_A, ...CHECK, kind: "exam_pass" });
  assert.equal(unknown.status, 422, "a kind that isn't entered by hand is the entry check's to refuse");
  assert.equal(app.world.db.records.length, 0);
});

test("a training manager enters every kind, corrects and imports, and is refused personnel", async () => {
  const app = load(MANAGER_A);
  const entered = await app.api.enter({ learnerId: LEARNER_A, kind: "qualification", title: "Type rating", occurredOn: "2026-09-01", result: "pass", assessorName: "A. Assessor", evidenceRef: "Cert 9" });
  assert.equal(entered.status, 201);
  const { record } = await entered.json();
  assert.equal(record.recordedBy, "manager@a.test");
  assert.equal((await app.api.enter({ learnerId: LEARNER_A, ...CHECK, kind: "acp_ppc", checkType: undefined })).status, 201);

  const corrected = await app.api.correct(record.recordId, { reason: "Wrong date.", changes: { occurredOn: "2026-09-02" } });
  assert.equal(corrected.status, 201);
  assert.equal((await corrected.json()).record.recordedBy, "manager@a.test");
  assert.equal((await app.api.import(CSV, true)).status, 200);
  assert.equal((await (await app.api.import(CSV, false)).json()).written, 2);

  assert.equal((await app.api.personnel(LEARNER_A)).status, 403);
  assert.equal((await app.api.addPersonnel(LEARNER_A, { dutyPosition: "pilot", effectiveFrom: "2025-01-01" })).status, 403);
  assert.equal(app.world.db.records.length, 5);
});

test("an instructor or a training manager of another tenant finds nothing here", async () => {
  for (const role of ["instructor", "training_manager"]) {
    const app = load({ tenantId: TENANT_B, email: `${role}@b.test`, role });
    assert.equal((await app.api.enter({ learnerId: LEARNER_A, ...CHECK })).status, 404, role);
    assert.equal((await app.api.learnerRecords(LEARNER_A)).status, 404, role);
    assert.equal(app.world.db.records.length, 0);
  }
});

test("an unexpected failure is 500 with no detail, logged by message only", async () => {
  const app = load();
  app.world.db.faults.before = () => new Error("db down: Server=prod;Password=hunter2");
  for (const res of await Promise.all(app.every())) {
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Something went wrong" });
  }
});
