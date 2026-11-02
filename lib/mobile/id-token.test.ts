import { test } from "node:test";
import assert from "node:assert/strict";
import { MobileTokenError, homeIdp, identityFromClaims } from "./id-token";

const TID = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";

const claims = (over: Record<string, unknown> = {}) => ({
  tid: TID,
  iss: `https://login.microsoftonline.com/${TID}/v2.0`,
  oid: "AAAA-BBBB",
  name: "Test User",
  preferred_username: "Test.User@Example.com",
  ...over,
});

const refused = (c: Record<string, unknown>, reason: string) =>
  assert.throws(() => identityFromClaims(c), (e: unknown) => e instanceof MobileTokenError && e.reason === reason);

test("a member's UPN is the verified email", () => {
  const who = identityFromClaims(claims());
  assert.equal(who.email, "test.user@example.com");
  assert.equal(who.emailVerified, true);
  assert.equal(who.oid, "aaaa-bbbb");
  assert.equal(who.tid, TID);
});

test("the free-text email claim is a label, never verified", () => {
  const who = identityFromClaims(claims({ preferred_username: undefined, email: "someone@else.example" }));
  assert.equal(who.email, "someone@else.example");
  assert.equal(who.emailVerified, false);
});

test("B2B guests are refused (idp names another directory, or an #EXT# UPN)", () => {
  refused(claims({ idp: homeIdp(OTHER) }), "guest");
  refused(claims({ idp: "live.com" }), "guest");
  refused(claims({ preferred_username: "a_b.com#EXT#@example.onmicrosoft.com" }), "guest");
  assert.equal(identityFromClaims(claims({ idp: homeIdp(TID) })).email, "test.user@example.com");
});

test("missing tenant, oid or address is refused", () => {
  refused(claims({ tid: undefined }), "tenant");
  refused(claims({ oid: undefined }), "oid");
  refused(claims({ preferred_username: "not-an-address" }), "email");
});
