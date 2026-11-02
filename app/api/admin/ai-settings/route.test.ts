import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import * as roles from "@/lib/auth/roles";
import { gradingWorld, OTHER, TENANT, vmLoad, type WorldOptions } from "@/lib/fixtures/fake-grading-db";

// The tenant admin's AI marking switch (slice A5a): admins of the session's
// own tenant only, off until one turns it on, every change recorded with who
// made it in the same transaction, and `available` says whether the platform
// has AI on for the tenant at all.

type Session = { tenantId?: string; email: string; role?: string } | null;
const ADMIN = { tenantId: TENANT, email: "admin@a.test", role: "admin" };

function load(options: WorldOptions = {}, start: Session = ADMIN) {
  const w = gradingWorld(options);
  let session: Session = start;
  const gate = vmLoad(new URL("../../../../lib/auth/staff-gate.ts", import.meta.url), {
    "@/lib/get-session": { getSessionUser: async () => session },
    "@/lib/auth/roles": roles,
    "@/lib/logging": w.logging,
  });
  const route = vmLoad(new URL("./route.ts", import.meta.url), {
    zod: { z }, "@/lib/auth/staff-gate": gate, "@/lib/ai/authoring/limits": w.limits, "@/lib/db/ai-settings": w.aiSettings, "@/lib/logging": w.logging,
  });
  const put = (body: unknown) => route.PUT(new Request("https://a.example/api/admin/ai-settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
  })) as Promise<Response>;
  return { w, route, put, get: () => route.GET() as Promise<Response>, as: (next: Session) => { session = next; } };
}

test("signed out is 401, no tenant is 400, a learner or an author is 403, and nothing is read or written", async () => {
  for (const [session, status] of [
    [null, 401],
    [{ email: "x@a.test", role: "admin" }, 400],
    [{ tenantId: TENANT, email: "x@a.test", role: "learner" }, 403],
    [{ tenantId: TENANT, email: "x@a.test", role: "author" }, 403],
    [{ tenantId: TENANT, email: "x@a.test" }, 403],
  ] as const) {
    const app = load({ marking: [] }, session);
    assert.equal((await app.get()).status, status, JSON.stringify(session));
    assert.equal((await app.put({ gradeWrittenAnswers: true })).status, status);
    assert.equal(app.w.db.statements.length, 0);
    assert.equal(app.w.db.settings.length, 0);
    assert.equal(app.w.db.audit.length, 0);
  }
});

test("off by default; an admin turns it on, the change and who made it are recorded together, and another tenant is untouched", async () => {
  const app = load({ marking: [] });
  const before = await app.get();
  assert.equal(before.headers.get("cache-control"), "no-store");
  assert.deepEqual(await before.json(), { gradeWrittenAnswers: false, available: true, updatedBy: null, updatedAt: null });

  const res = await app.put({ gradeWrittenAnswers: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.gradeWrittenAnswers, true);
  assert.equal(body.updatedBy, "admin@a.test");
  assert.deepEqual(app.w.db.audit.map((a) => [a.TenantId, a.Actor, a.Verb, a.ObjectKind, JSON.parse(a.MetaJson)]), [
    [TENANT, "admin@a.test", "ai.settings.update", "tenant", { gradeWrittenAnswers: true, was: false }],
  ]);
  const batch = app.w.db.statements.find((s) => s.sql.includes("INSERT INTO lms.TenantAiSetting"))!.sql;
  assert.match(batch, /^SET XACT_ABORT ON; BEGIN TRANSACTION; .* INSERT INTO lms\.AuditEvent .* COMMIT TRANSACTION;/);
  assert.equal(await app.w.policy.aiMarkingEnabled(TENANT), true);
  assert.equal(await app.w.policy.aiMarkingEnabled(OTHER), false);

  app.as({ tenantId: OTHER, email: "admin@b.test", role: "admin" });
  assert.equal((await (await app.get()).json()).gradeWrittenAnswers, false);

  app.as(ADMIN);
  await app.put({ gradeWrittenAnswers: false });
  assert.deepEqual(JSON.parse(app.w.db.audit.at(-1)!.MetaJson), { gradeWrittenAnswers: false, was: true });
  assert.equal(await app.w.policy.aiMarkingEnabled(TENANT), false);
});

test("with the platform switch off the setting saves but reads as unavailable, and marking stays off", async () => {
  const app = load({ platform: "", marking: [] });
  const body = await (await app.put({ gradeWrittenAnswers: true })).json();
  assert.equal(body.gradeWrittenAnswers, true);
  assert.equal(body.available, false);
  assert.equal(await app.w.policy.aiMarkingEnabled(TENANT), false);
});

test("anything but a boolean gradeWrittenAnswers is 400 and writes nothing", async () => {
  const app = load({ marking: [] });
  for (const body of ["not json", {}, { gradeWrittenAnswers: "yes" }, { gradeWrittenAnswers: 1 }, { gradeWrittenAnswers: true, tenantId: OTHER }]) {
    const res = await app.put(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(app.w.db.settings.length, 0);
  assert.equal(app.w.db.audit.length, 0);
});
