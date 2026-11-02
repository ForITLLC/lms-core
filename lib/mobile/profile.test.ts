import { test } from "node:test";
import assert from "node:assert/strict";
import { profileFromRow } from "./profile";
import type { TenantProfileRow } from "@/lib/db/tenants";

const USER = { email: "a@example.com", name: "A", role: "learner" };

const row = (over: Partial<TenantProfileRow>): TenantProfileRow => ({
  Slug: "forit",
  Name: "ForIT",
  CustomHostname: null,
  CompanyName: "ForIT",
  LogoUrl: "/images/forit-logo-with-text.png",
  LogoWhiteUrl: "/images/forit-lockup-white.png",
  PrimaryColor: null,
  AccentColor: null,
  SupportEmail: null,
  ...over,
});

test("a client tenant keeps its own logos on its own host", () => {
  const { tenant } = profileFromRow(
    row({
      Slug: "operator",
      CustomHostname: "learn.operator.example",
      LogoUrl: "/tenants/operator/logo.png",
      LogoWhiteUrl: null,
    }),
    USER,
  );
  assert.equal(tenant.logo_url, "https://learn.operator.example/tenants/operator/logo.png");
  assert.equal(tenant.logo_white_url, null);
});
