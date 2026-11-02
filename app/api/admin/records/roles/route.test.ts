import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import * as permissions from "@/lib/auth/records-permissions";
import * as roles from "@/lib/auth/roles";
import { flat, vmLoad } from "@/lib/fixtures/fake-grading-db";

// Giving the instructor and training-manager roles (card d3e16430, slice
// R2b): canGrantRecordsRoles (the admin's alone) in the session's own tenant,
// only where that tenant's records are switched on; an admin or an author is
// never changed and nobody is made one; another tenant's person is 404; each
// change writes its audit event. The route runs over lib/db/users.ts and a
// fake lms.AppUser that applies the statement only where its tenant filter is
// in the SQL text.

type Session = { tenantId?: string; email: string; role?: string } | null;
type AppUser = { AppUserId: string; TenantId: string; Email: string; DisplayName: string; Role: string };

const T = "aaaaaaaa-0000-4000-8000-00000000000a";
const OTHER = "bbbbbbbb-0000-4000-8000-00000000000b";
const SLUGS: Record<string, string> = { [T]: "tenant-a", [OTHER]: "tenant-b" };
const ADMIN_ID = "a0000000-0000-4000-8000-000000000001";
const AUTHOR_ID = "a0000000-0000-4000-8000-000000000002";
const PILOT_ID = "A0000000-0000-4000-8000-000000000003";
const CAPTAIN_ID = "a0000000-0000-4000-8000-000000000004";
const OUTSIDER_ID = "b0000000-0000-4000-8000-000000000001";
const ADMIN = { tenantId: T, email: "admin@a.test", role: "admin" };

function people(): AppUser[] {
  return [
    { AppUserId: ADMIN_ID.toUpperCase(), TenantId: T, Email: "admin@a.test", DisplayName: "Ada Admin", Role: "admin" },
    { AppUserId: AUTHOR_ID.toUpperCase(), TenantId: T, Email: "author@a.test", DisplayName: "Al Author", Role: "author" },
    { AppUserId: PILOT_ID.toUpperCase(), TenantId: T, Email: "pilot@a.test", DisplayName: "Pat Pilot", Role: "learner" },
    { AppUserId: CAPTAIN_ID.toUpperCase(), TenantId: T, Email: "captain@a.test", DisplayName: "Cam Captain", Role: "instructor" },
    { AppUserId: OUTSIDER_ID.toUpperCase(), TenantId: OTHER, Email: "pilot@b.test", DisplayName: "Bo B", Role: "learner" },
  ];
}

function load(session: Session = ADMIN, tenants = "tenant-a,tenant-b", fail = false) {
  const users = people();
  const audit: Record<string, unknown>[] = [];
  const statements: string[] = [];
  const runs: unknown[][] = [];
  const errors: unknown[][] = [];
  const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
  const db = {
    execute: async () => { throw new Error("unexpected execute"); },
    query: async (sql: string, p: Record<string, any>) => {
      statements.push(sql);
      if (fail) throw new Error("db down: Server=prod;Password=hunter2");
      assert.match(flat(sql), /FROM lms\.AppUser WHERE TenantId = @tenantId ORDER BY DisplayName/);
      return users.filter((u) => same(u.TenantId, p.tenantId)).sort((a, b) => a.DisplayName.localeCompare(b.DisplayName))
        .map(({ AppUserId, Email, DisplayName, Role }) => ({ AppUserId, Email, DisplayName, Role }));
    },
    queryOne: async (sql: string, p: Record<string, any>) => {
      statements.push(sql);
      if (fail) throw new Error("db down: Server=prod;Password=hunter2");
      const text = flat(sql);
      const row = users.find((u) => same(u.TenantId, p.tenantId) && (same(u.AppUserId, p.appUserId) || same(u.Email, p.email)));
      if (text.startsWith("SELECT Role FROM lms.AppUser")) return row ? { Role: row.Role } : null;
      assert.match(text, /WITH \(UPDLOCK, HOLDLOCK\) WHERE TenantId = @tenantId AND AppUserId = @appUserId;/);
      if (!row) return { Was: null, Email: null, Changed: 0 };
      const was = row.Role;
      const moves = ["learner", "instructor", "training_manager"];
      if (moves.includes(was) && moves.includes(p.role) && was !== p.role) {
        row.Role = p.role;
        audit.push({ TenantId: p.tenantId, Actor: p.by, Verb: "role.set", ObjectKind: "AppUser", ObjectId: p.appUserId, MetaJson: `{"from":"${was}","to":"${p.role}"}` });
        return { Was: was, Email: row.Email, Changed: 1 };
      }
      return { Was: was, Email: row.Email, Changed: 0 };
    },
  };
  const logging = { recordServiceRun: async (...a: unknown[]) => { runs.push(a); }, recordError: async (...a: unknown[]) => { errors.push(a); } };
  const usersModule = vmLoad(new URL("../../../../../lib/db/users.ts", import.meta.url), {
    "@/lib/db": db, "@/lib/auth/roles": roles, "@/lib/auth/records-permissions": permissions, "@/lib/auth/tenant-binding": { chooseTenantBinding: () => null },
  });
  const gate = vmLoad(new URL("../../../../../lib/auth/staff-gate.ts", import.meta.url), {
    "@/lib/get-session": { getSessionUser: async () => session }, "@/lib/auth/roles": roles, "@/lib/logging": logging,
  });
  const recordsSwitch = vmLoad(new URL("../../../../../lib/records/switch.ts", import.meta.url), {
    "@/lib/db/tenants": { getTenantSlug: async (id: string) => SLUGS[id.toLowerCase()] ?? null },
  }, { process: { env: { TRAINING_RECORDS_TENANTS: tenants } } });
  const recordsGate = vmLoad(new URL("../../../../../lib/records/gate.ts", import.meta.url), { "@/lib/auth/staff-gate": gate, "./switch": recordsSwitch });
  const route = vmLoad(new URL("./route.ts", import.meta.url), {
    zod: { z }, "@/lib/auth/records-permissions": permissions, "@/lib/auth/staff-gate": gate, "@/lib/db/users": usersModule,
    "@/lib/records/gate": recordsGate, "@/lib/logging": logging,
  });
  const list = () => route.GET() as Promise<Response>;
  const put = (body: unknown) => route.PUT(new Request("https://a.example/api/admin/records/roles", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
  })) as Promise<Response>;
  const roleOf = (id: string) => users.find((u) => same(u.AppUserId, id))!.Role;
  return { list, put, users, usersModule, audit, statements, runs, errors, roleOf };
}

test("signed out is 401, no tenant is 400, anyone but an admin is 403, and nothing is read or written", async () => {
  for (const [session, status] of [
    [null, 401],
    [{ email: "x@a.test", role: "admin" }, 400],
    ...["learner", "author", "instructor", "training_manager", "Admin"].map((role) => [{ tenantId: T, email: "x@a.test", role }, 403] as const),
    [{ tenantId: T, email: "x@a.test" }, 403],
  ] as const) {
    const app = load(session);
    assert.equal((await app.list()).status, status, JSON.stringify(session));
    assert.equal((await app.put({ appUserId: PILOT_ID, role: "instructor" })).status, status, JSON.stringify(session));
    assert.deepEqual(app.statements, []);
    assert.equal(app.roleOf(PILOT_ID), "learner");
  }
});

test("where the tenant's records are off, the roles can't be given: 404 for its admin, nothing read or written", async () => {
  for (const tenants of ["", "tenant-b"]) {
    const app = load(ADMIN, tenants);
    for (const res of [await app.list(), await app.put({ appUserId: PILOT_ID, role: "instructor" })]) {
      assert.equal(res.status, 404, tenants);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
    assert.deepEqual(app.statements, []);
    assert.deepEqual(app.audit, []);
    assert.equal(app.roleOf(PILOT_ID), "learner");
  }
});

test("an admin lists the people of their own tenant only, with their stored roles", async () => {
  const res = await load().list();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.deepEqual(body.people.map((p: { appUserId: string; role: string }) => [p.appUserId, p.role]), [
    [ADMIN_ID, "admin"], [AUTHOR_ID, "author"], [CAPTAIN_ID, "instructor"], [PILOT_ID.toLowerCase(), "learner"],
  ]);
  assert.deepEqual(body.roles, ["learner", "instructor", "training_manager"]);
});

test("an admin makes a learner an instructor, then a training manager, then a learner again; each change is audited as who made it", async () => {
  const app = load();
  assert.equal(await app.usersModule.currentAppUserRole(T, "pilot@a.test"), "learner");

  const first = await app.put({ appUserId: PILOT_ID, role: "instructor" });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.deepEqual(await first.json(), { appUserId: PILOT_ID.toLowerCase(), role: "instructor", was: "learner", changed: true });
  assert.equal(app.roleOf(PILOT_ID), "instructor");
  assert.equal(await app.usersModule.currentAppUserRole(T, "pilot@a.test"), "instructor", "the cached learner role is forgotten at once");

  const again = await app.put({ appUserId: PILOT_ID, role: "instructor" });
  assert.deepEqual(await again.json(), { appUserId: PILOT_ID.toLowerCase(), role: "instructor", was: "instructor", changed: false });
  assert.equal((await app.put({ appUserId: PILOT_ID, role: "training_manager" })).status, 200);
  assert.equal((await app.put({ appUserId: PILOT_ID, role: "learner" })).status, 200);
  assert.equal(app.roleOf(PILOT_ID), "learner");

  assert.deepEqual(app.audit.map((a) => [a.TenantId, a.Actor, a.Verb, a.ObjectKind, a.ObjectId, a.MetaJson]), [
    [T, "admin@a.test", "role.set", "AppUser", PILOT_ID.toLowerCase(), `{"from":"learner","to":"instructor"}`],
    [T, "admin@a.test", "role.set", "AppUser", PILOT_ID.toLowerCase(), `{"from":"instructor","to":"training_manager"}`],
    [T, "admin@a.test", "role.set", "AppUser", PILOT_ID.toLowerCase(), `{"from":"training_manager","to":"learner"}`],
  ]);
  assert.deepEqual(app.runs.map((r) => [r[0], r[1], r[3]]), [
    ["lms-records", "SUCCESS", 1], ["lms-records", "SUCCESS", 0], ["lms-records", "SUCCESS", 1], ["lms-records", "SUCCESS", 1],
  ]);
  for (const run of app.runs) assert.doesNotMatch(String(run[4]), /@/, "the log names ids, never an email");
});

test("an admin or an author is never changed here: 409, role kept, nothing audited", async () => {
  const app = load();
  for (const id of [ADMIN_ID, AUTHOR_ID]) {
    for (const role of ["learner", "instructor", "training_manager"]) {
      const res = await app.put({ appUserId: id, role });
      assert.equal(res.status, 409, `${id} ${role}`);
      assert.equal((await res.json()).code, "other_role");
    }
  }
  assert.equal(app.roleOf(ADMIN_ID), "admin");
  assert.equal(app.roleOf(AUTHOR_ID), "author");
  assert.deepEqual(app.audit, []);
  assert.deepEqual(app.runs, []);
});

test("nobody is made an admin or an author, and a bad body is refused before anything is read", async () => {
  const app = load();
  for (const body of [
    { appUserId: PILOT_ID, role: "admin" },
    { appUserId: PILOT_ID, role: "author" },
    { appUserId: PILOT_ID, role: "Instructor" },
    { appUserId: PILOT_ID, role: "instructor", tenantId: OTHER },
    { appUserId: "not-a-uuid", role: "instructor" },
    { role: "instructor" },
    "{",
  ]) {
    assert.equal((await app.put(body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(app.statements, []);
  assert.equal(app.roleOf(PILOT_ID), "learner");
});

test("another tenant's person is 404 and untouched; an unknown id is 404", async () => {
  const app = load();
  const res = await app.put({ appUserId: OUTSIDER_ID, role: "training_manager" });
  assert.equal(res.status, 404);
  assert.equal(app.roleOf(OUTSIDER_ID), "learner");
  assert.equal((await app.put({ appUserId: "c0000000-0000-4000-8000-000000000009", role: "instructor" })).status, 404);
  assert.deepEqual(app.audit, []);

  const fromB = load({ tenantId: OTHER, email: "admin@b.test", role: "admin" });
  assert.equal((await fromB.put({ appUserId: PILOT_ID, role: "instructor" })).status, 404);
  assert.equal(fromB.roleOf(PILOT_ID), "learner");
});

test("a failure is 500 without the error text, logged once", async () => {
  const app = load(ADMIN, "tenant-a", true);
  for (const res of [await app.list(), await app.put({ appUserId: PILOT_ID, role: "instructor" })]) {
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.ok(!text.includes("hunter2") && !text.includes("Server="), text);
  }
  assert.equal(app.errors.length, 2);
});
