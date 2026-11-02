import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MANUAL_KINDS } from "@/lib/records/manual";
import {
  canCorrectRecords, canGrantRecordsRoles, canImportRecords, canManagePersonnel, canMarkExams, canMarkLeft, canReadRecords,
  canWriteRecordKind, canWriteRecords, RECORDS_ROLES, recordsRights, writableKinds,
} from "./records-permissions";

// Every training-records right lives in records-permissions.ts, and card
// d3e16430 ("add both", 2026-10-29) sets who holds each: an instructor reads,
// enters the training it runs or assesses and marks exams; a training manager
// also corrects, imports, marks a learner left and enters every kind; personnel
// rows and giving roles stay the admin's. Every records route and page asks the
// helpers rather than comparing roles itself.

const HELPERS = {
  canReadRecords, canWriteRecords, canCorrectRecords, canImportRecords, canManagePersonnel, canMarkLeft, canMarkExams, canGrantRecordsRoles,
};
const NOBODY = ["learner", "Admin", "admin ", "Instructor", "training-manager", "trainingmanager", "manager", "", null, undefined];

// The card's table: who holds each right.
const HOLDERS: Record<keyof typeof HELPERS, string[]> = {
  canReadRecords: ["admin", "training_manager", "instructor"],
  canWriteRecords: ["admin", "training_manager", "instructor"],
  canCorrectRecords: ["admin", "training_manager"],
  canImportRecords: ["admin", "training_manager"],
  canManagePersonnel: ["admin"],
  canMarkLeft: ["admin", "training_manager"],
  canMarkExams: ["admin", "author", "training_manager", "instructor"],
  canGrantRecordsRoles: ["admin"],
};
const ROLES = ["admin", "author", "training_manager", "instructor", ...NOBODY];

test("each right is held by exactly the roles the card gives it", () => {
  for (const [name, can] of Object.entries(HELPERS)) {
    const holders = HOLDERS[name as keyof typeof HELPERS];
    for (const role of ROLES) {
      assert.equal(can(role), holders.includes(role as string), `${name}(${JSON.stringify(role)})`);
    }
  }
  assert.equal(canReadRecords("author"), false, "an author is staff but holds no records right");
});

test("an instructor writes only the training it runs or assesses; a training manager and an admin write every kind", () => {
  const instructorKinds = ["check", "ojt", "line_indoc", "familiarization", "monitor", "vendor_training"];
  assert.deepEqual([...writableKinds("instructor")], instructorKinds);
  assert.deepEqual([...writableKinds("training_manager")], [...MANUAL_KINDS]);
  assert.deepEqual([...writableKinds("admin")], [...MANUAL_KINDS]);
  for (const role of ["author", ...NOBODY]) assert.deepEqual([...writableKinds(role)], [], String(role));

  for (const kind of MANUAL_KINDS) {
    assert.equal(canWriteRecordKind("admin", kind), true, kind);
    assert.equal(canWriteRecordKind("training_manager", kind), true, kind);
    assert.equal(canWriteRecordKind("instructor", kind), instructorKinds.includes(kind), `instructor ${kind}`);
    assert.equal(canWriteRecordKind("author", kind), false, kind);
    assert.equal(canWriteRecordKind("learner", kind), false, kind);
  }
  assert.equal(canWriteRecordKind("instructor", "qualification"), false);
  assert.equal(canWriteRecordKind("instructor", "acp_ppc"), false);
  assert.equal(canWriteRecordKind("admin", "exam_pass"), false, "an automatic kind is never entered by hand");
});

test("the rights handed to the records page", () => {
  const plain = (role: string | undefined) => JSON.parse(JSON.stringify(recordsRights(role)));
  assert.deepEqual(plain("admin"), { write: true, correct: true, import: true, personnel: true, markLeft: true, kinds: [...MANUAL_KINDS], ownTraining: false });
  assert.deepEqual(plain("training_manager"), { write: true, correct: true, import: true, personnel: false, markLeft: true, kinds: [...MANUAL_KINDS], ownTraining: false });
  assert.deepEqual(plain("instructor"), {
    write: true, correct: false, import: false, personnel: false, markLeft: false,
    kinds: ["check", "ojt", "line_indoc", "familiarization", "monitor", "vendor_training"], ownTraining: true,
  });
  for (const role of ["author", "learner", undefined]) {
    assert.deepEqual(plain(role), { write: false, correct: false, import: false, personnel: false, markLeft: false, kinds: [], ownTraining: false });
  }
});

test("the roles an admin sets never include admin or author", () => {
  assert.deepEqual([...RECORDS_ROLES], ["learner", "instructor", "training_manager"]);
});

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

// Each records handler and the right it must ask for.
const ROUTES: [string, string, string][] = [
  ["app/api/admin/records/route.ts", "GET", "canReadRecords"],
  ["app/api/admin/records/route.ts", "POST", "canWriteRecords"],
  ["app/api/admin/records/[recordId]/route.ts", "GET", "canReadRecords"],
  ["app/api/admin/records/[recordId]/corrections/route.ts", "POST", "canCorrectRecords"],
  ["app/api/admin/records/import/route.ts", "POST", "canImportRecords"],
  ["app/api/admin/records/roles/route.ts", "GET", "canGrantRecordsRoles"],
  ["app/api/admin/records/roles/route.ts", "PUT", "canGrantRecordsRoles"],
  ["app/api/admin/learners/[learnerId]/personnel/route.ts", "GET", "canManagePersonnel"],
  ["app/api/admin/learners/[learnerId]/personnel/route.ts", "POST", "canManagePersonnel"],
  ["app/api/admin/learners/[learnerId]/status/route.ts", "PUT", "canMarkLeft"],
  ["app/api/author/grades/route.ts", "POST", "canMarkExams"],
];
const PAGES = ["app/admin/records/page.tsx", "components/RecordsManager.tsx", "lib/records/gate.ts", "components/nav-items.ts", "app/author/grading/page.tsx"];
const INLINE_ROLE = /\brole\s*[!=]==?|[!=]==?\s*(?:session\.)?role\b|["'](?:admin|author|instructor|training_manager)["']/;

test("every records handler asks its own right first, and no records route or page compares roles itself", () => {
  for (const [path, method, right] of ROUTES) {
    const source = read(path);
    const body = source.split(new RegExp(String.raw`export async function ${method}\(`))[1];
    assert.ok(body, `${path} exports ${method}`);
    const firstGate = /await (requireRecordsRight|requireTenantRole)\((\w+)\)/.exec(body);
    assert.equal(firstGate?.[2], right, `${path} ${method} asks ${right}`);
    assert.match(source, /from "@\/lib\/auth\/records-permissions";/);
  }
  for (const path of [...new Set(ROUTES.map(([p]) => p)), ...PAGES]) {
    assert.doesNotMatch(read(path), INLINE_ROLE, `${path} compares a role inline`);
  }
  assert.match(read("app/api/admin/records/route.ts"), /canWriteRecordKind\(gate\.role, kind\)/, "POST also asks the kind");
  assert.match("if (session.role === x)", INLINE_ROLE, "known positive");
  assert.match(`ok("instructor")`, INLINE_ROLE, "known positive");
});
