import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { asRole, isStaffRole } from "./roles";

function load(file: string, modules: Record<string, unknown>) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, console, Date, Map, require: (name: string) => { if (!(name in modules)) throw new Error(name); return modules[name]; } });
  return exports;
}

const roles = { asRole, isStaffRole };

test("an unknown or missing role reads as learner, never staff", () => {
  for (const role of ["admin", "author", "learner", "instructor", "training_manager"]) assert.equal(asRole(role), role);
  for (const v of [null, undefined, "", "Admin", "owner", "Instructor", "training-manager", "trainingmanager", "training_manager "]) {
    assert.equal(asRole(v), "learner", JSON.stringify(v));
  }
  assert.equal(isStaffRole("learner"), false);
  assert.equal(isStaffRole(undefined), false);
});

test("an instructor or a training manager is not staff", () => {
  assert.equal(isStaffRole("admin"), true, "known positive");
  assert.equal(isStaffRole("author"), true, "known positive");
  assert.equal(isStaffRole("instructor"), false);
  assert.equal(isStaffRole("training_manager"), false);
});

test("platform staff means a staff role in the ForIT tenant only", async () => {
  const platform = load("./platform.ts", {
    "@/lib/auth/roles": roles,
    "@/lib/db/catalogue": { isForitTenant: async (id: string) => id === "T-FORIT" },
  });
  assert.equal(await platform.isPlatformStaff({ tenantId: "T-FORIT", role: "author" }), true);
  assert.equal(await platform.isPlatformStaff({ tenantId: "T-FORIT", role: "admin" }), true);
  assert.equal(await platform.isPlatformStaff({ tenantId: "T-FORIT", role: "learner" }), false);
  assert.equal(await platform.isPlatformStaff({ tenantId: "T-FORIT", role: "instructor" }), false);
  assert.equal(await platform.isPlatformStaff({ tenantId: "T-FORIT", role: "training_manager" }), false);
  assert.equal(await platform.isPlatformStaff({ tenantId: "T-GN", role: "admin" }), false);
  assert.equal(await platform.isPlatformStaff({ role: "admin" }), false);
});

function bindWith(opts: { hrGroup?: string | null; groups?: string[]; stored?: string | null; upsertThrows?: boolean }) {
  const upserts: any[] = [];
  const server = load("../auth-config-server.ts", {
    "server-only": {},
    "@/lib/auth-config": { authConfig: {} },
    "@/lib/auth/roles": roles,
    "@/lib/db/users": {
      resolveTenantIdForSession: async () => "T",
      upsertAppUser: async (input: any) => { if (opts.upsertThrows) throw new Error("db down"); upserts.push(input); },
      getAppUserRole: async () => opts.stored ?? null,
    },
    "@/lib/db/tenants": { getHrAdminAdGroupId: async () => opts.hrGroup ?? null },
    "@/lib/graph": { getTransitiveGroupIds: async () => opts.groups ?? [] },
  });
  const session = { email: "Pilot@Example.Test", name: "Pilot", azureOid: "OID", tid: "TID", expiresAt: 0 };
  return { bind: () => server.bindLmsSession(session), upserts };
}

test("a first sign-in in a database-managed tenant is a learner and writes no role", async () => {
  const { bind, upserts } = bindWith({ stored: "learner" });
  const out = await bind();
  assert.equal(out.role, "learner");
  assert.equal(upserts[0].role, undefined);
  assert.equal(upserts[0].demoteAdmin, false);
  assert.equal(upserts[0].email, "pilot@example.test");
});

test("a seeded admin keeps admin in a database-managed tenant", async () => {
  const { bind } = bindWith({ stored: "admin" });
  assert.equal((await bind()).role, "admin");
});

test("an admin-group member becomes admin; a non-member keeps the stored role with admin capped", async () => {
  const member = bindWith({ hrGroup: "G", groups: ["G", "X"], stored: "admin" });
  const m = await member.bind();
  assert.equal(m.role, "admin");
  assert.equal(member.upserts[0].role, "admin");
  assert.deepEqual(m.groups, ["G", "X"]);

  const outsider = bindWith({ hrGroup: "G", groups: ["X"], stored: "learner" });
  assert.equal((await outsider.bind()).role, "learner");
  assert.equal(outsider.upserts[0].role, undefined);
  assert.equal(outsider.upserts[0].demoteAdmin, true);
});

test("a stored instructor or training manager keeps the role through every sign-in path but the admin group", async () => {
  for (const stored of ["instructor", "training_manager"]) {
    const outsider = bindWith({ hrGroup: "G", groups: ["X"], stored });
    assert.equal((await outsider.bind()).role, stored, `group-managed non-member, ${stored}`);
    assert.equal(outsider.upserts[0].role, undefined, "signing in writes no role");
    assert.equal(outsider.upserts[0].demoteAdmin, true, "the only demotion is admin to author, in the upsert's SQL");

    const database = bindWith({ stored });
    assert.equal((await database.bind()).role, stored, `database-managed, ${stored}`);
    assert.equal(database.upserts[0].role, undefined);

    const member = bindWith({ hrGroup: "G", groups: ["G"], stored });
    assert.equal(member.upserts.length, 0);
    await member.bind();
    assert.equal(member.upserts[0].role, "admin", "the admin group still makes a member admin");
  }
});

test("a failed write fails closed to learner", async () => {
  const { bind } = bindWith({ upsertThrows: true, stored: "admin" });
  assert.equal((await bind()).role, "learner");
});
