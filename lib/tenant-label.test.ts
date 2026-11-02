import { test } from "node:test";
import assert from "node:assert/strict";
import { NEUTRAL_THEME } from "./theme";
import { learningLabel, tenantDisplayName } from "./tenant-label";

test("a tenant shows its company name, then its name", () => {
  assert.equal(tenantDisplayName({ slug: "operator", company_name: "Operator Air", name: "operator" }), "Operator Air");
  assert.equal(tenantDisplayName({ slug: "charter", company_name: "", name: "Charter Co" }), "Charter Co");
});

test("no resolved tenant names no organisation, never ForIT or the package placeholder", () => {
  assert.equal(tenantDisplayName(NEUTRAL_THEME), null);
  assert.equal(tenantDisplayName({ slug: "x", company_name: "", name: "" }), null);
  assert.equal(learningLabel(tenantDisplayName(NEUTRAL_THEME)), "Learning");
});

test("the label joins the name and Learning", () => {
  assert.equal(learningLabel("Operator Air"), "Operator Air · Learning");
  assert.equal(learningLabel("Operator Air", " "), "Operator Air Learning");
});
