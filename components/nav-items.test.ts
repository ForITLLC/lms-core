import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { navItemsFor } from "./nav-items";

// The header links per role (card d3e16430): staff get the author tools and
// /admin; an instructor or a training manager can open neither, so they get
// the marking queue and the training records instead; a learner gets neither.

const COMMON = ["/dashboard", "/dashboard/summary", "/learn", "/drill", "/dashboard/settings"];
const hrefs = (role: string | undefined) => navItemsFor(role).map((i) => i.href);

test("each role's header links", () => {
  for (const role of ["admin", "author"]) assert.deepEqual(hrefs(role), [...COMMON, "/author", "/admin", "/api/auth/logout"], role);
  for (const role of ["instructor", "training_manager"]) {
    assert.deepEqual(hrefs(role), [...COMMON, "/admin/records", "/author/grading", "/api/auth/logout"], role);
  }
  for (const role of ["learner", undefined, "Admin", "manager"]) assert.deepEqual(hrefs(role), [...COMMON, "/api/auth/logout"], String(role));
  assert.deepEqual(navItemsFor("instructor").slice(-3).map((i) => i.label), ["Training records", "Marking", "Sign out"]);
});

test("the Shell takes its links from navItemsFor and compares no role itself", () => {
  const shell = readFileSync(new URL("./Shell.tsx", import.meta.url), "utf8");
  assert.match(shell, /navItemsFor\(session\.role\)/);
  assert.doesNotMatch(shell, /session\.role\s*[!=]==?|["'](?:admin|author|instructor|training_manager)["']/);
});
