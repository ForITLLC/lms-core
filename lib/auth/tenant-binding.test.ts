import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseTenantBinding, type TenantCandidate } from "./tenant-binding";

const PINNED_TID = "0a1b2c3d-0000-4000-8000-00000000000a";
const OPEN_TID = "0b1c2d3e-0000-4000-8000-00000000000b";
const EVIL_TID = "11111111-2222-3333-4444-555555555555";

const rows: TenantCandidate[] = [
  { TenantId: "t-pinned", AadTenantId: PINNED_TID, Domain: "pinned.example" },
  { TenantId: "t-open", AadTenantId: null, Domain: "open.example" },
];

test("member of the pinned directory binds to its tenant", () => {
  assert.equal(chooseTenantBinding(rows, { tid: PINNED_TID, email: "member@pinned.example", emailVerified: true }), "t-pinned");
});

test("member of the pinned directory binds by tid even when the email is not domain-verified", () => {
  assert.equal(chooseTenantBinding(rows, { tid: PINNED_TID, email: "x@other.example", emailVerified: false }), "t-pinned");
});

test("ATTACK: foreign tenant presenting the pinned domain's email is not bound", () => {
  assert.equal(chooseTenantBinding(rows, { tid: EVIL_TID, email: "ceo@pinned.example", emailVerified: true }), null);
});

test("ATTACK: foreign tenant with an unverified pinned-domain mail is not bound", () => {
  assert.equal(chooseTenantBinding(rows, { tid: EVIL_TID, email: "ceo@pinned.example", emailVerified: false }), null);
});

test("ATTACK: unverified email cannot claim a domain-bound tenant", () => {
  assert.equal(chooseTenantBinding(rows, { tid: EVIL_TID, email: "ops@open.example", emailVerified: false }), null);
});

test("ATTACK: pre-0.7.0 session shape (no emailVerified) cannot bind by domain", () => {
  assert.equal(chooseTenantBinding(rows, { tid: EVIL_TID, email: "ops@open.example" }), null);
});

test("guest never binds, even from the pinned tenant", () => {
  assert.equal(
    chooseTenantBinding(rows, { tid: PINNED_TID, email: "member@pinned.example", emailVerified: true, isGuest: true }),
    null,
  );
});

test("verified email of an unpinned tenant binds by domain", () => {
  assert.equal(chooseTenantBinding(rows, { tid: OPEN_TID, email: "Ops@Open.Example", emailVerified: true }), "t-open");
});

test("sign-in from a tenant with no LMS row stays unbound", () => {
  assert.equal(chooseTenantBinding(rows, { tid: EVIL_TID, email: "someone@elsewhere.example", emailVerified: true }), null);
});

test("missing tid never binds", () => {
  assert.equal(chooseTenantBinding(rows, { email: "member@pinned.example", emailVerified: true }), null);
});

test("tid comparison is case-insensitive", () => {
  assert.equal(
    chooseTenantBinding(rows, { tid: PINNED_TID.toUpperCase(), email: "member@pinned.example", emailVerified: true }),
    "t-pinned",
  );
});
