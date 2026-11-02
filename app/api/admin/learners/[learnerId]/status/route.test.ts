import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import * as permissions from "@/lib/auth/records-permissions";
import * as roles from "@/lib/auth/roles";
import { vmLoad } from "@/lib/fixtures/fake-grading-db";

// Marking a learner left or active (slice R1b): canMarkLeft
// (@/lib/auth/records-permissions: an admin, and since card d3e16430 a
// training manager, never an instructor) in the session's own tenant, a learner of another tenant is 404, nothing is ever deleted,
// and only 'active' and 'left' can be sent.

type Session = { tenantId?: string; email: string; role?: string } | null;
const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const L = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const ADMIN = { tenantId: T, email: "admin@a.test", role: "admin" };

function load(session: Session = ADMIN, learners: Record<string, Record<string, string>> = { [T]: { [L.toLowerCase()]: "active" }, [OTHER]: {} }, fail = false) {
  const calls: unknown[][] = [];
  const runs: unknown[][] = [];
  const errors: unknown[][] = [];
  const logging = { recordServiceRun: async (...a: unknown[]) => { runs.push(a); }, recordError: async (...a: unknown[]) => { errors.push(a); } };
  const gate = vmLoad(new URL("../../../../../../lib/auth/staff-gate.ts", import.meta.url), {
    "@/lib/get-session": { getSessionUser: async () => session },
    "@/lib/auth/roles": roles,
    "@/lib/logging": logging,
  });
  const statuses = {
    LEARNER_STATUSES: ["active", "left"] as const,
    setLearnerStatus: async (tenantId: string, learnerId: string, status: string, by: string) => {
      calls.push([tenantId, learnerId, status, by]);
      if (fail) throw new Error("db down: Server=prod;Password=hunter2");
      const was = learners[tenantId]?.[learnerId];
      if (!was) return { outcome: "not_found" };
      if (was !== "active" && was !== "left") return { outcome: "other_status", status: was };
      learners[tenantId]![learnerId] = status;
      return { outcome: was === status ? "unchanged" : "changed", status, was };
    },
  };
  const route = vmLoad(new URL("./route.ts", import.meta.url), {
    zod: { z }, "@/lib/auth/staff-gate": gate, "@/lib/auth/records-permissions": permissions, "@/lib/db/learner-status": statuses, "@/lib/logging": logging,
  });
  const put = (id: string, body: unknown) => route.PUT(
    new Request(`https://a.example/api/admin/learners/${id}/status`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }),
    { params: Promise.resolve({ learnerId: id }) },
  ) as Promise<Response>;
  return { put, calls, runs, errors, learners };
}

test("signed out is 401, no tenant is 400, a learner, an author or an instructor is 403, and nothing is written", async () => {
  for (const [session, status] of [
    [null, 401],
    [{ email: "x@a.test", role: "admin" }, 400],
    [{ tenantId: T, email: "x@a.test", role: "learner" }, 403],
    [{ tenantId: T, email: "x@a.test", role: "author" }, 403],
    [{ tenantId: T, email: "x@a.test", role: "instructor" }, 403],
    [{ tenantId: T, email: "x@a.test" }, 403],
  ] as const) {
    const app = load(session);
    assert.equal((await app.put(L, { status: "left" })).status, status, JSON.stringify(session));
    assert.equal(app.calls.length, 0);
  }
});

test("an admin marks a learner left and back, scoped to the admin's tenant and recorded as who did it", async () => {
  const app = load();
  const left = await app.put(L, { status: "left" });
  assert.equal(left.status, 200);
  assert.equal(left.headers.get("cache-control"), "no-store");
  assert.deepEqual(await left.json(), { learnerId: L.toLowerCase(), status: "left", was: "active", changed: true });
  assert.deepEqual(app.calls[0], [T, L.toLowerCase(), "left", "admin@a.test"]);
  assert.equal(app.learners[T]![L.toLowerCase()], "left");

  const again = await app.put(L, { status: "left" });
  assert.deepEqual(await again.json(), { learnerId: L.toLowerCase(), status: "left", was: "left", changed: false });

  const back = await app.put(L, { status: "active" });
  assert.deepEqual(await back.json(), { learnerId: L.toLowerCase(), status: "active", was: "left", changed: true });
  assert.deepEqual(app.runs.map((r) => [r[0], r[1], r[3]]), [["lms-learners", "SUCCESS", 1], ["lms-learners", "SUCCESS", 0], ["lms-learners", "SUCCESS", 1]]);
});

test("another tenant's learner is 404 and untouched; a bad id or body is refused before any write", async () => {
  const learners = { [T]: {}, [OTHER]: { [L.toLowerCase()]: "active" } };
  const app = load(ADMIN, learners);
  assert.equal((await app.put(L, { status: "left" })).status, 404);
  assert.equal(learners[OTHER]![L.toLowerCase()], "active");
  assert.deepEqual(app.calls, [[T, L.toLowerCase(), "left", "admin@a.test"]]);

  const fresh = load();
  for (const [id, body, status] of [
    ["not-a-uuid", { status: "left" }, 404],
    [L, { status: "deleted" }, 400],
    [L, { status: "inactive" }, 400],
    [L, { status: "left", tenantId: OTHER }, 400],
    [L, "{", 400],
    [L, {}, 400],
  ] as const) {
    assert.equal((await fresh.put(id, body)).status, status, JSON.stringify(body));
  }
  assert.equal(fresh.calls.length, 0);
});

test("a learner with another status is 409, and a failure is 500 without the error text", async () => {
  const app = load(ADMIN, { [T]: { [L.toLowerCase()]: "inactive" } });
  const res = await app.put(L, { status: "active" });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "other_status");

  const broken = load(ADMIN, undefined, true);
  const failed = await broken.put(L, { status: "left" });
  assert.equal(failed.status, 500);
  const text = await failed.text();
  assert.ok(!text.includes("hunter2") && !text.includes("Server="));
  assert.equal(broken.errors.length, 1);
});

test("a training manager marks a learner left and back, recorded as who did it", async () => {
  const app = load({ tenantId: T, email: "manager@a.test", role: "training_manager" });
  const left = await app.put(L, { status: "left" });
  assert.equal(left.status, 200);
  assert.deepEqual(await left.json(), { learnerId: L.toLowerCase(), status: "left", was: "active", changed: true });
  assert.deepEqual(app.calls[0], [T, L.toLowerCase(), "left", "manager@a.test"]);
  assert.equal((await app.put(L, { status: "active" })).status, 200);
  assert.equal(app.learners[T]![L.toLowerCase()], "active");

  const elsewhere = load({ tenantId: OTHER, email: "manager@b.test", role: "training_manager" });
  assert.equal((await elsewhere.put(L, { status: "left" })).status, 404);
});
