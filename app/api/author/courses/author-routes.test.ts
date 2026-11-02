import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";
import * as roles from "@/lib/auth/roles";
import * as draftOps from "@/lib/builder/draft-ops";
import * as fork from "@/lib/builder/fork";
import * as draftSchema from "@/lib/schema/draft";

// The builder's API: an author or admin of the session's own tenant only,
// never cached, and the draft itself never reaches a log line.

const TENANT = "0e0e0e0e-0000-0000-0000-00000000000a";
const COURSE = "c0c0c0c0-0000-0000-0000-00000000000c";
const OTHER = "d0d0d0d0-0000-0000-0000-00000000000d";
const DRAFT = "dddddddd-0000-0000-0000-00000000000d";
const EARLIER = "eeeeeeee-0000-0000-0000-00000000000e";
const SECRET = "Body text that must never be logged";

const doc = draftSchema.DraftDoc.parse({
  meta: { title: "Ramp safety" },
  lessons: [{ key: "l1", title: "One", blocks: [{ kind: "text", key: "b1", markdown: SECRET }] }],
});
const record = { courseId: COURSE, draftId: DRAFT, slug: "ramp-safety", status: "draft", baseVersionId: null, revision: 3, doc, updatedAt: new Date(0), updatedBy: "a" };

function transpile(path: URL) {
  return ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}

function evaluate(path: URL, modules: Record<string, unknown>) {
  const exports: any = {};
  runInNewContext(transpile(path), {
    exports, Response, Date, JSON, Promise, Error, String, URL,
    require: (id: string) => { if (!(id in modules)) throw new Error(`unexpected import ${id}`); return modules[id]; },
  });
  return exports;
}

type Session = { tenantId?: string; email: string; role?: string } | null;

class UnreadableDraftError extends fork.UnreadableVersionError {
  constructor(readonly draftId: string, readonly revision: number) {
    super("This draft holds something the course builder can no longer open.");
  }
}

function load(session: Session = { tenantId: TENANT, email: "author@example.test", role: "author" }, behaviour: Record<string, unknown> = {}) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const logs: string[] = [];
  const own = (tenantId: unknown, courseId: unknown) => tenantId === TENANT && courseId === COURSE;
  const spy = (fn: string, impl: (...args: any[]) => unknown) => async (...args: any[]) => { calls.push({ fn, args }); return impl(...args); };
  const logging = {
    recordServiceRun: async (...args: unknown[]) => { logs.push(JSON.stringify(args)); },
    recordError: async (...args: unknown[]) => { logs.push(JSON.stringify(args)); },
  };
  const gate = evaluate(new URL("../../../../lib/auth/staff-gate.ts", import.meta.url), {
    "@/lib/get-session": { getSessionUser: async () => session },
    "@/lib/auth/roles": roles,
    "@/lib/logging": logging,
  });
  const drafts = {
    UnreadableDraftError,
    listAuthorCourses: spy("listAuthorCourses", () => []),
    createCourse: spy("createCourse", () => ({ courseId: COURSE, slug: "ramp-safety" })),
    getDraft: spy("getDraft", (t, c) => {
      if (behaviour.unreadableDraft) throw new UnreadableDraftError(DRAFT, 3);
      return own(t, c) ? record : null;
    }),
    openDraft: spy("openDraft", (t, c) => {
      if (behaviour.unreadableDraft) throw new UnreadableDraftError(DRAFT, 3);
      if (behaviour.unreadable) throw new fork.UnreadableBlockError(1, 2);
      return own(t, c) ? record : null;
    }),
    editDraft: spy("editDraft", (t, c) => {
      if (behaviour.unreadableDraft) throw new UnreadableDraftError(DRAFT, 3);
      return own(t, c) ? behaviour.edit ?? { ok: true, draftId: DRAFT, revision: 4, doc } : { ok: false, reason: "not_found" };
    }),
    discardDraft: spy("discardDraft", (t, c, ref) => {
      if (!own(t, c)) return { ok: false, reason: "not_found" };
      return ref.draftId === DRAFT && ref.revision === 3 ? { ok: true } : { ok: false, reason: "conflict" };
    }),
  };
  const publish = {
    publishDraft: spy("publishDraft", (t, c) => {
      if (behaviour.unreadableDraft) throw new UnreadableDraftError(DRAFT, 3);
      return own(t, c) ? behaviour.publish ?? { ok: true, versionId: OTHER, versionNumber: 2 } : { ok: false, reason: "not_found" };
    }),
  };
  const modules = {
    zod: { z },
    "@/lib/auth/staff-gate": gate,
    "@/lib/db/course-drafts": drafts,
    "@/lib/db/course-publish": publish,
    "@/lib/builder/draft-ops": draftOps,
    "@/lib/builder/fork": fork,
    "@/lib/schema/draft": draftSchema,
    "@/lib/logging": logging,
  };
  return {
    courses: evaluate(new URL("./route.ts", import.meta.url), modules),
    draft: evaluate(new URL("./[courseId]/draft/route.ts", import.meta.url), modules),
    publish: evaluate(new URL("./[courseId]/publish/route.ts", import.meta.url), modules),
    calls,
    logs,
  };
}

const req = (method: string, body?: unknown, query = "") =>
  new Request(`https://tenant.example/api/author/courses${query}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const at = (courseId: string) => ({ params: Promise.resolve({ courseId }) });

function everyHandler(app: ReturnType<typeof load>, courseId = COURSE): Promise<Response>[] {
  return [
    app.courses.GET(),
    app.courses.POST(req("POST", { title: "Ramp safety" })),
    app.draft.GET(req("GET"), at(courseId)),
    app.draft.POST(req("POST"), at(courseId)),
    app.draft.PATCH(req("PATCH", { draftId: DRAFT, revision: 3, ops: [{ op: "removeLesson", lessonKey: "l1" }] }), at(courseId)),
    app.draft.DELETE(req("DELETE", undefined, `?draftId=${DRAFT}&revision=3`), at(courseId)),
    app.publish.POST(req("POST", { draftId: DRAFT, revision: 3 }), at(courseId)),
  ];
}

test("signed out is 401, no tenant is 400, a learner, an instructor or a training manager is 403, and none of them reach the database", async () => {
  for (const [session, status] of [
    [null, 401],
    [{ email: "x@example.test", role: "author" }, 400],
    [{ tenantId: TENANT, email: "x@example.test", role: "learner" }, 403],
    [{ tenantId: TENANT, email: "x@example.test" }, 403],
    // Card d3e16430: an instructor and a training manager mark exams and keep
    // training records, but never build or publish a course.
    [{ tenantId: TENANT, email: "x@example.test", role: "instructor" }, 403],
    [{ tenantId: TENANT, email: "x@example.test", role: "training_manager" }, 403],
  ] as const) {
    const app = load(session);
    for (const res of await Promise.all(everyHandler(app))) {
      assert.equal(res.status, status, JSON.stringify(session));
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
    assert.equal(app.calls.length, 0);
  }
});

test("authors and admins work in their session's tenant only", async () => {
  for (const role of ["author", "admin"]) {
    const app = load({ tenantId: TENANT, email: `${role}@example.test`, role });
    const responses = await Promise.all(everyHandler(app));
    assert.deepEqual(responses.map((r) => r.status), [200, 201, 200, 200, 200, 200, 200]);
    for (const res of responses) assert.equal(res.headers.get("cache-control"), "no-store");
    for (const call of app.calls) assert.equal(call.args[0], TENANT, call.fn);
    const created = app.calls.find((c) => c.fn === "createCourse")!;
    assert.equal(created.args[1], `${role}@example.test`);
  }
});

test("another tenant's course, or something that isn't a course id, is 404", async () => {
  const other = load();
  assert.deepEqual((await Promise.all(everyHandler(other, OTHER))).slice(2).map((r) => r.status), [404, 404, 404, 404, 404]);
  const junk = load();
  assert.deepEqual((await Promise.all(everyHandler(junk, "../../etc"))).slice(2).map((r) => r.status), [404, 404, 404, 404, 404]);
  assert.equal(junk.calls.filter((c) => c.fn !== "listAuthorCourses" && c.fn !== "createCourse").length, 0);
});

test("a body naming a tenant or carrying junk is refused before any write", async () => {
  const app = load();
  assert.equal((await app.courses.POST(req("POST", { title: "x", tenantId: OTHER }))).status, 400);
  assert.equal((await app.courses.POST(req("POST", { title: "  " }))).status, 400);
  assert.equal((await app.draft.PATCH(req("PATCH", { draftId: DRAFT, revision: 3, ops: [] }), at(COURSE))).status, 400);
  assert.equal((await app.draft.PATCH(req("PATCH", { draftId: DRAFT, ops: [{ op: "removeLesson", lessonKey: "l1" }] }), at(COURSE))).status, 400);
  assert.equal((await app.draft.PATCH(req("PATCH", { revision: 3, ops: [{ op: "removeLesson", lessonKey: "l1" }] }), at(COURSE))).status, 400);
  assert.equal((await app.publish.POST(req("POST", { draftId: DRAFT, revision: 0 }), at(COURSE))).status, 400);
  assert.equal((await app.publish.POST(req("POST", { revision: 3 }), at(COURSE))).status, 400);
  for (const query of ["", `?draftId=${DRAFT}`, "?revision=3", `?draftId=${DRAFT}&revision=`, `?draftId=${DRAFT}&revision=0`, `?draftId=${DRAFT}&revision=-1`, `?draftId=${DRAFT}&revision=3.5`, `?draftId=${DRAFT}&revision=3abc`, `?draftId=nope&revision=3`]) {
    const res = await app.draft.DELETE(req("DELETE", undefined, query), at(COURSE));
    assert.equal(res.status, 400, query);
    assert.equal((await res.json()).code, "invalid", query);
  }
  assert.equal(app.calls.length, 0);
});

test("a stale edit is 409 and an edit the draft refuses is 422", async () => {
  const stale = load(undefined, { edit: { ok: false, reason: "conflict" } });
  const res = await stale.draft.PATCH(req("PATCH", { draftId: DRAFT, revision: 3, ops: [{ op: "removeLesson", lessonKey: "l1" }] }), at(COURSE));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "conflict");

  const refused = load(undefined, { edit: { ok: false, reason: "invalid", error: "a package block can't be edited" } });
  const bad = await refused.draft.PATCH(req("PATCH", { draftId: DRAFT, revision: 3, ops: [{ op: "removeLesson", lessonKey: "l1" }] }), at(COURSE));
  assert.equal(bad.status, 422);
  assert.deepEqual(await bad.json(), { error: "a package block can't be edited", code: "invalid" });
});

test("publish answers 409 for a stale draft or a moved base, and 422 with the problems", async () => {
  for (const [result, status, code] of [
    [{ ok: false, reason: "draft_conflict" }, 409, "draft_conflict"],
    [{ ok: false, reason: "base_moved" }, 409, "base_moved"],
    [{ ok: false, reason: "not_publishable", problems: [{ where: "Course", problem: "Add at least one lesson." }] }, 422, "not_publishable"],
  ] as const) {
    const app = load(undefined, { publish: result });
    const res = await app.publish.POST(req("POST", { draftId: DRAFT, revision: 3 }), at(COURSE));
    assert.equal(res.status, status);
    const body = await res.json();
    assert.equal(body.code, code);
    if (code === "not_publishable") assert.deepEqual(body.problems, [{ where: "Course", problem: "Add at least one lesson." }]);
  }
  const ok = load();
  const res = await ok.publish.POST(req("POST", { draftId: DRAFT.toUpperCase(), revision: 3, changeNote: "Fixes" }), at(COURSE.toUpperCase()));
  assert.deepEqual(await res.json(), { versionId: OTHER, versionNumber: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(ok.calls[0]!.args)), [TENANT, COURSE, "author@example.test", { draftId: DRAFT, revision: 3 }, "Fixes"]);
});

test("discard names the draft and the revision; a replaced draft or a stale revision is 409 and nothing else is read", async () => {
  for (const query of [`?draftId=${EARLIER}&revision=3`, `?draftId=${DRAFT}&revision=2`, `?draftId=${DRAFT}&revision=4`]) {
    const app = load();
    const res = await app.draft.DELETE(req("DELETE", undefined, query), at(COURSE));
    assert.equal(res.status, 409, query);
    assert.equal((await res.json()).code, "draft_conflict", query);
    assert.deepEqual(app.calls.map((c) => c.fn), ["discardDraft"]);
  }
  const app = load();
  const res = await app.draft.DELETE(req("DELETE", undefined, `?draftId=${DRAFT.toUpperCase()}&revision=3`), at(COURSE));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls[0]!.args)), [TENANT, COURSE, { draftId: DRAFT, revision: 3 }]);
  const gone = await load().draft.DELETE(req("DELETE", undefined, `?draftId=${DRAFT}&revision=3`), at(OTHER));
  assert.equal(gone.status, 404);
});

test("a stored draft the builder can't read answers 422 with its id and revision, not a crash", async () => {
  const app = load(undefined, { unreadableDraft: true });
  for (const res of [
    await app.draft.GET(req("GET"), at(COURSE)),
    await app.draft.POST(req("POST"), at(COURSE)),
    await app.draft.PATCH(req("PATCH", { draftId: DRAFT, revision: 3, ops: [{ op: "removeLesson", lessonKey: "l1" }] }), at(COURSE)),
  ]) {
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.code, "unreadable");
    assert.equal(body.draftId, DRAFT);
    assert.equal(body.revision, 3);
  }
  const publish = await app.publish.POST(req("POST", { draftId: DRAFT, revision: 3 }), at(COURSE));
  assert.equal(publish.status, 422);
  assert.equal((await publish.json()).code, "unreadable");
  assert.equal((await app.draft.DELETE(req("DELETE", undefined, `?draftId=${DRAFT}&revision=3`), at(COURSE))).status, 200);
});

test("a published version the builder can't read opens as 422, not a crash", async () => {
  const app = load(undefined, { unreadable: true });
  const res = await app.draft.POST(req("POST"), at(COURSE));
  assert.equal(res.status, 422);
  assert.equal((await res.json()).code, "unreadable");
});

test("the draft's content never reaches a log line", async () => {
  const app = load();
  await Promise.all(everyHandler(app));
  const failing = load();
  (failing as any).draft = evaluate(new URL("./[courseId]/draft/route.ts", import.meta.url), {
    zod: { z },
    "@/lib/auth/staff-gate": evaluate(new URL("../../../../lib/auth/staff-gate.ts", import.meta.url), {
      "@/lib/get-session": { getSessionUser: async () => ({ tenantId: TENANT, email: "a@example.test", role: "author" }) },
      "@/lib/auth/roles": roles,
      "@/lib/logging": { recordError: async (...args: unknown[]) => { app.logs.push(JSON.stringify(args)); } },
    }),
    "@/lib/db/course-drafts": { UnreadableDraftError, editDraft: async () => { throw new Error("connection reset"); } },
    "@/lib/builder/draft-ops": draftOps,
    "@/lib/builder/fork": fork,
    "@/lib/schema/draft": draftSchema,
    "@/lib/logging": { recordServiceRun: async () => {} },
  });
  const res = await (failing as any).draft.PATCH(req("PATCH", { draftId: DRAFT, revision: 3, ops: [{ op: "updateBlock", lessonKey: "l1", block: { kind: "text", key: "b1", markdown: SECRET } }] }), at(COURSE));
  assert.equal(res.status, 500);
  assert.ok(app.logs.some((line) => line.includes("connection reset")));
  assert.ok(app.logs.length >= 4);
  for (const line of app.logs) assert.equal(line.includes(SECRET), false, line);
});
