import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as roles from "@/lib/auth/roles";
import { canMarkExams } from "@/lib/auth/records-permissions";

// The author pages' staff check, run without the Next runtime: next/navigation's
// redirect is replaced by one that throws what it was given, as the real one does.

const TENANT = "0e0e0e0e-0000-0000-0000-00000000000a";
const COURSE = "c0c0c0c0-0000-0000-0000-00000000000c";

type Session = { tenantId?: string; email: string; role?: string } | null;

class Redirected {
  constructor(readonly to: string) {}
}

function load(session: Session) {
  const source = readFileSync(new URL("./author-page.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const modules: Record<string, unknown> = {
    "next/navigation": {
      redirect: (to: string) => {
        throw new Redirected(to);
      },
    },
    "@/lib/get-session": { getSessionUser: async () => session },
    "@/lib/auth/roles": roles,
  };
  const exports: any = {};
  runInNewContext(js, {
    exports,
    Promise,
    encodeURIComponent,
    require: (id: string) => {
      if (!(id in modules)) throw new Error(`unexpected import ${id}`);
      return modules[id];
    },
  });
  return exports as typeof import("./author-page");
}

// The module runs in its own realm, so its objects are compared as plain JSON.
async function outcome(session: Session, returnTo = "/author", allowed?: (role: string | undefined) => boolean) {
  try {
    return { access: JSON.parse(JSON.stringify(await load(session).requireAuthorPage(returnTo, allowed))) };
  } catch (error) {
    if (error instanceof Redirected) return { redirect: error.to };
    throw error;
  }
}

test("the decision: signed out, no tenant, not staff, or staff", () => {
  const { authorPageDecision } = load(null);
  assert.equal(authorPageDecision(null), "login");
  assert.equal(authorPageDecision({ role: "author" }), "no_tenant");
  assert.equal(authorPageDecision({ role: "admin" }), "no_tenant");
  assert.equal(authorPageDecision({ tenantId: TENANT, role: "learner" }), "not_staff");
  assert.equal(authorPageDecision({ tenantId: TENANT }), "not_staff");
  assert.equal(authorPageDecision({ tenantId: TENANT, role: "superuser" as never }), "not_staff");
  assert.equal(authorPageDecision({ tenantId: TENANT, role: "author" }), "ok");
  assert.equal(authorPageDecision({ tenantId: TENANT, role: "admin" }), "ok");
  assert.equal(authorPageDecision({ tenantId: TENANT, role: "instructor" }), "not_staff");
  assert.equal(authorPageDecision({ tenantId: TENANT, role: "training_manager" }), "not_staff");
});

test("signed out goes to sign-in and comes back to the page it asked for", async () => {
  assert.deepEqual(await outcome(null), { redirect: "/api/auth/login?returnTo=/author" });
  assert.deepEqual(await outcome(null, `/author/courses/${COURSE}`), {
    redirect: `/api/auth/login?returnTo=/author/courses/${COURSE}`,
  });
});

test("a returnTo that isn't a same-site path comes back to /author", async () => {
  for (const returnTo of ["//evil.example/x", "https://evil.example/", "author"]) {
    assert.deepEqual(await outcome(null, returnTo), { redirect: "/api/auth/login?returnTo=/author" }, returnTo);
  }
  assert.deepEqual(await outcome(null, "/author/courses/a&b=c"), {
    redirect: "/api/auth/login?returnTo=/author/courses/a%26b%3Dc",
  });
});

test("a learner, or a session with no role, is sent to the learner home", async () => {
  assert.deepEqual(await outcome({ tenantId: TENANT, email: "l@example.test", role: "learner" }), { redirect: "/dashboard" });
  assert.deepEqual(await outcome({ tenantId: TENANT, email: "l@example.test" }), { redirect: "/dashboard" });
});

test("a session bound to no tenant gets the notice, not a redirect", async () => {
  assert.deepEqual(await outcome({ email: "a@example.test", role: "author" }), { access: { ok: false, reason: "no_tenant" } });
  assert.deepEqual(await outcome({ email: "x@example.test" }), { access: { ok: false, reason: "no_tenant" } });
});

test("an author or admin gets their own tenant and email", async () => {
  for (const role of ["author", "admin"]) {
    assert.deepEqual(await outcome({ tenantId: TENANT, email: `${role}@example.test`, role }), {
      access: { ok: true, tenantId: TENANT, email: `${role}@example.test`, staff: true },
    });
  }
});

// Card d3e16430: an instructor and a training manager mark exams, so the
// marking queue passes canMarkExams; every other author page keeps the staff
// check and sends them to the learner home.
test("an instructor or a training manager is sent away from an author page, and let into one that passes canMarkExams", async () => {
  for (const role of ["instructor", "training_manager"]) {
    const session = { tenantId: TENANT, email: `${role}@example.test`, role };
    assert.deepEqual(await outcome(session), { redirect: "/dashboard" }, role);
    assert.deepEqual(await outcome(session, "/author/grading", canMarkExams), {
      access: { ok: true, tenantId: TENANT, email: `${role}@example.test`, staff: false },
    }, role);
  }
  for (const role of ["author", "admin"]) {
    assert.deepEqual(await outcome({ tenantId: TENANT, email: "s@example.test", role }, "/author/grading", canMarkExams), {
      access: { ok: true, tenantId: TENANT, email: "s@example.test", staff: true },
    }, role);
  }
  assert.deepEqual(await outcome({ tenantId: TENANT, email: "l@example.test", role: "learner" }, "/author/grading", canMarkExams), { redirect: "/dashboard" });
  assert.deepEqual(await outcome(null, "/author/grading", canMarkExams), { redirect: "/api/auth/login?returnTo=/author/grading" });
  assert.deepEqual(await outcome({ email: "i@example.test", role: "instructor" }, "/author/grading", canMarkExams), { access: { ok: false, reason: "no_tenant" } });
});
