import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as roles from "@/lib/auth/roles";
import * as permissions from "@/lib/auth/records-permissions";
import { flat, vmLoad } from "@/lib/fixtures/fake-grading-db";

// Giving and taking away the instructor and training-manager roles (card
// d3e16430, slice R2b): one tenant-scoped statement that moves a role only
// among learner, instructor and training_manager and writes its audit event in
// the same transaction; and signing in never writes either role.

type Row = { Was: string | null; Email: string | null; Changed: boolean | number } | null;

function load(setRow: Row = { Was: "learner", Email: "pilot@a.test", Changed: 1 }) {
  const calls: Array<{ sql: string; params: Record<string, unknown> }> = [];
  let stored = "learner";
  const db = {
    execute: async (sql: string, params: Record<string, unknown>) => { calls.push({ sql, params }); return 1; },
    query: async () => [],
    queryOne: async (sql: string, params: Record<string, unknown>) => {
      calls.push({ sql, params });
      if (sql.includes("SET XACT_ABORT ON")) return setRow;
      return { Role: stored };
    },
  };
  const mod = vmLoad(new URL("./users.ts", import.meta.url), {
    "@/lib/db": db,
    "@/lib/auth/roles": roles,
    "@/lib/auth/records-permissions": permissions,
    "@/lib/auth/tenant-binding": { chooseTenantBinding: () => null },
  });
  return { mod, calls, setStored: (role: string) => { stored = role; } };
}

test("the statement is tenant-scoped, locks the row, moves only the three records roles and writes its audit event in one transaction", async () => {
  const { mod, calls } = load();
  await mod.setRecordsRole("T", "U", "instructor", "admin@a.test");
  assert.deepEqual({ ...calls[0]!.params }, { tenantId: "T", appUserId: "U", role: "instructor", by: "admin@a.test" });
  const sql = flat(mod.SET_RECORDS_ROLE);
  assert.match(sql, /^SET XACT_ABORT ON; SET NOCOUNT ON; BEGIN TRANSACTION;/);
  assert.match(sql, /FROM lms\.AppUser WITH \(UPDLOCK, HOLDLOCK\) WHERE TenantId = @tenantId AND AppUserId = @appUserId;/);
  assert.match(sql, /IF @was IN \(N'learner', N'instructor', N'training_manager'\) AND @role IN \(N'learner', N'instructor', N'training_manager'\) AND @was <> @role BEGIN/);
  assert.match(sql, /UPDATE lms\.AppUser SET Role = @role WHERE TenantId = @tenantId AND AppUserId = @appUserId; INSERT INTO lms\.AuditEvent \(EventId, TenantId, Actor, Verb, ObjectKind, ObjectId, MetaJson\) VALUES \(NEWID\(\), @tenantId, @by, 'role\.set', 'AppUser',/);
  assert.match(sql, /COMMIT TRANSACTION; SELECT @was AS Was, @email AS Email, @changed AS Changed;$/);
  assert.doesNotMatch(sql, /DELETE|'admin'|'author'/i);
  assert.equal((sql.match(/UPDATE lms\.AppUser/g) ?? []).length, 1);
});

test("the outcome says what happened; an admin, an author or an unknown role is reported, not moved", async () => {
  const outcome = async (row: Row, role = "training_manager") => ({ ...(await load(row).mod.setRecordsRole("T", "U", role, "a")) });
  assert.deepEqual(await outcome({ Was: "learner", Email: "p@a.test", Changed: 1 }), { outcome: "changed", role: "training_manager", was: "learner" });
  assert.deepEqual(await outcome({ Was: "instructor", Email: "p@a.test", Changed: true }, "learner"), { outcome: "changed", role: "learner", was: "instructor" });
  assert.deepEqual(await outcome({ Was: "training_manager", Email: "p@a.test", Changed: 0 }), { outcome: "unchanged", role: "training_manager", was: "training_manager" });
  assert.deepEqual(await outcome({ Was: null, Email: null, Changed: 0 }), { outcome: "not_found" });
  assert.deepEqual(await outcome(null), { outcome: "not_found" });
  for (const was of ["admin", "author", "owner"]) {
    assert.deepEqual(await outcome({ Was: was, Email: "p@a.test", Changed: 0 }), { outcome: "other_role", role: was });
  }
});

test("a role taken away stops counting on this instance at once, not after the cache's minute", async () => {
  const app = load({ Was: "instructor", Email: "Pilot@A.test", Changed: 1 });
  app.setStored("instructor");
  assert.equal(await app.mod.currentAppUserRole("T", "pilot@a.test", 1_000), "instructor");
  app.setStored("learner");
  assert.equal(await app.mod.currentAppUserRole("T", "pilot@a.test", 2_000), "instructor", "known positive: the cache holds the old role");
  await app.mod.setRecordsRole("T", "U", "learner", "admin@a.test");
  assert.equal(await app.mod.currentAppUserRole("T", "pilot@a.test", 3_000), "learner");

  const unchanged = load({ Was: "instructor", Email: "pilot@a.test", Changed: 0 });
  unchanged.setStored("instructor");
  await unchanged.mod.currentAppUserRole("T", "pilot@a.test", 1_000);
  const reads = unchanged.calls.length;
  await unchanged.mod.setRecordsRole("T", "U", "instructor", "admin@a.test");
  await unchanged.mod.currentAppUserRole("T", "pilot@a.test", 2_000);
  assert.equal(unchanged.calls.length, reads + 1, "nothing changed, so the cached role stands");
});

test("signing in writes a role only from the admin group, and the only demotion it makes is admin to author", async () => {
  const { mod, calls } = load();
  await mod.upsertAppUser({ tenantId: "T", email: "p@a.test", displayName: "P", demoteAdmin: true });
  const sql = flat(calls[0]!.sql);
  assert.match(sql, /Role = CASE WHEN @role IS NOT NULL THEN @role WHEN @demoteAdmin = 1 AND Role = 'admin' THEN 'author' ELSE Role END/);
  assert.match(sql, /COALESCE\(@role, 'learner'\)/);
  assert.doesNotMatch(sql, /instructor|training_manager/);
  assert.equal(calls[0]!.params.role, null);
});

function users(stored: () => string | null) {
  const calls: { sql: string; params: any }[] = [];
  const mod = vmLoad(new URL("./users.ts", import.meta.url), {
    "@/lib/db": {
      execute: async (sql: string, params: any) => { calls.push({ sql, params }); return 1; },
      query: async () => [],
      queryOne: async (sql: string, params: any) => { calls.push({ sql, params }); const r = stored(); return r === null ? null : { Role: r }; },
    },
    "@/lib/auth/roles": roles,
    "@/lib/auth/records-permissions": permissions,
    "@/lib/auth/tenant-binding": { chooseTenantBinding: () => null },
  });
  return { mod, calls };
}

test("a new AppUser row defaults to learner, and a non-member's stored admin drops to author", async () => {
  const { mod, calls } = users(() => null);
  await mod.upsertAppUser({ tenantId: "T", email: "a@x.test", displayName: "A", demoteAdmin: true });
  const { sql, params } = calls[0]!;
  assert.match(sql, /COALESCE\(@role, 'learner'\)/);
  assert.doesNotMatch(sql, /'author'\), SYSUTCDATETIME/);
  assert.match(sql, /WHEN @demoteAdmin = 1 AND Role = 'admin' THEN 'author'/);
  assert.equal(params.role, null);
  assert.equal(params.demoteAdmin, 1);
});

test("the current role is re-read after a minute and an unknown row is a learner", async () => {
  let stored: string | null = "author";
  const { mod, calls } = users(() => stored);
  assert.equal(await mod.currentAppUserRole("T", "Pilot@X.test", 0), "author");
  assert.equal(calls[0]!.params.email, "pilot@x.test");
  stored = "learner";
  assert.equal(await mod.currentAppUserRole("T", "pilot@x.test", 59_000), "author");
  assert.equal(await mod.currentAppUserRole("T", "pilot@x.test", 60_000), "learner");
  stored = null;
  assert.equal(await mod.currentAppUserRole("T", "nobody@x.test", 60_000), "learner");
  stored = "training_manager";
  assert.equal(await mod.currentAppUserRole("T", "manager@x.test", 60_000), "training_manager", "a stored records role is read back as itself");
});

test("the 0024 migration demotes only authorless authors outside ForIT and records each one", () => {
  const sql = readFileSync(new URL("../../db/migrations/0024_learner_role.sql", import.meta.url), "utf8");
  assert.match(sql, /DEFAULT \('learner'\) FOR Role/);
  assert.match(sql, /WHERE u\.Role = 'author'\s+AND t\.Slug <> 'forit'/);
  for (const evidence of ["c.CreatedBy = u.Email", "c.OwnerUserId = u.AppUserId", "v.PublishedBy = u.Email", "a.AssignedBy = u.Email", "k.AppUserId = u.AppUserId"]) {
    assert.ok(sql.includes(evidence), evidence);
  }
  assert.match(sql, /INSERT INTO lms\.AuditEvent[\s\S]+'role\.demote'[\s\S]+FROM @demoted/);
  assert.doesNotMatch(sql, /Role = 'admin'/);
});
