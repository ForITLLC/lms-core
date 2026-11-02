import { test } from "node:test";
import assert from "node:assert/strict";
import { NEUTRAL_THEME } from "./theme";
import { appHosts, normHost, resolveThemeForHost, rowToTheme, themeForHeaders, type BrandingRow } from "./tenant";

const row = (over: Partial<BrandingRow>): BrandingRow => ({
  Slug: "forit",
  Name: "ForIT",
  AadTenantId: null,
  CustomHostname: null,
  CompanyName: "ForIT",
  LogoUrl: "/images/forit-logo-with-text.png",
  LogoWhiteUrl: "/images/forit-lockup-white.png",
  FaviconUrl: "/images/forit-logo-with-text.png",
  PrimaryColor: null,
  SecondaryColor: null,
  AccentColor: null,
  FontFamily: null,
  SupportEmail: null,
  SupportPhone: null,
  WelcomeText: null,
  PortalWelcomeText: null,
  CustomCss: null,
  EmailSenderAddress: null,
  EmailSenderDisplayName: null,
  TenantId: "00000000-0000-0000-0000-000000000001",
  ...over,
});

test("a client theme keeps its own logos and favicon", () => {
  const theme = rowToTheme(
    row({ Slug: "operator", LogoUrl: "/operator/logo.png", LogoWhiteUrl: null, FaviconUrl: "/operator/icon.png" }),
  );
  assert.equal(theme.logo_url, "/operator/logo.png");
  assert.equal(theme.logo_white_url, undefined);
  assert.equal(theme.favicon_url, "/operator/icon.png");
});

const themes = [
  rowToTheme(row({})),
  rowToTheme(row({ Slug: "operator", Name: "Operator", CompanyName: "Operator Air", CustomHostname: "learn.operator.example", TenantId: "00000000-0000-0000-0000-000000000002" })),
  rowToTheme(row({ Slug: "charter", Name: "Charter", CompanyName: "Charter Co", TenantId: "00000000-0000-0000-0000-000000000003" })),
];
const opts = { apex: "learn.forit.io", apexSlug: "forit", appHosts: ["lms-app.azurewebsites.net"] };
const slugFor = (host: string | null) => resolveThemeForHost(host, themes, opts)?.slug ?? null;

test("a tenant resolves by its own hostname or its subdomain", () => {
  assert.equal(slugFor("learn.operator.example"), "operator");
  assert.equal(slugFor("LEARN.Operator.Example:443"), "operator");
  assert.equal(slugFor("operator.learn.forit.io"), "operator");
  assert.equal(slugFor("charter.learn.forit.io"), "charter");
});

test("the app's own hosts serve the apex tenant", () => {
  for (const host of [null, "", "learn.forit.io", "www.learn.forit.io", "localhost:3000", "127.0.0.1:3000", "lms-app.azurewebsites.net"]) {
    assert.equal(slugFor(host), "forit", String(host));
  }
});

test("an unknown host resolves to no tenant, never to the apex tenant's brand", () => {
  for (const host of ["nosuch.learn.forit.io", "a.b.learn.forit.io", "evil.example.com", "learn.forit.io.evil.example.com", "xlearn.forit.io", "charterxlearn.forit.io", "other-app.azurewebsites.net"]) {
    assert.equal(slugFor(host), null, host);
  }
});

test("without an apex tenant the app's own hosts get the neutral theme", () => {
  const clients = themes.filter((t) => t.slug !== "forit");
  assert.equal(resolveThemeForHost("learn.forit.io", clients, opts), NEUTRAL_THEME);
  assert.equal(resolveThemeForHost("nosuch.learn.forit.io", clients, opts), null);
});

test("with no tenants loaded every host gets the neutral theme, not a 404", () => {
  assert.equal(resolveThemeForHost("charter.learn.forit.io", [], opts), NEUTRAL_THEME);
  assert.equal(resolveThemeForHost("evil.example.com", [], opts), NEUTRAL_THEME);
});

test("hosts compare bare and lower-case: no port, list tail, IPv6 brackets or trailing dot", () => {
  assert.equal(normHost(" Learn.Operator.Example.:443 "), "learn.operator.example");
  assert.equal(normHost("charter.learn.forit.io, proxy.internal"), "charter.learn.forit.io");
  assert.equal(normHost("[::1]:3000"), "::1");
  assert.equal(normHost(null), "");
  assert.equal(slugFor("charter.learn.forit.io, proxy.internal"), "charter");
  assert.equal(slugFor("[::1]:3000"), "forit");
});

test("a stored hostname or slug matches whatever its case and padding", () => {
  const padded = [
    ...themes,
    rowToTheme(row({ Slug: "Acme", Name: "Acme", CompanyName: "Acme", CustomHostname: " Learn.Acme.Example. ", TenantId: "00000000-0000-0000-0000-000000000004" })),
  ];
  assert.equal(resolveThemeForHost("learn.acme.example", padded, opts)?.slug, "Acme");
  assert.equal(resolveThemeForHost("acme.learn.forit.io", padded, opts)?.slug, "Acme");
});

test("a custom hostname wins over the subdomain it sits under", () => {
  const owned = [
    ...themes,
    rowToTheme(row({ Slug: "other", Name: "Other", CompanyName: "Other", CustomHostname: "charter.learn.forit.io", TenantId: "00000000-0000-0000-0000-000000000005" })),
  ];
  assert.equal(resolveThemeForHost("charter.learn.forit.io", owned, opts)?.slug, "other");
});

test("App Service's default host is one of the app's own hosts", () => {
  assert.deepEqual(appHosts({ WEBSITE_HOSTNAME: "LMS-App.azurewebsites.net" }), ["lms-app.azurewebsites.net"]);
  assert.deepEqual(appHosts({ AZURE_APP_NAME: "lms-app" }), ["lms-app.azurewebsites.net"]);
  assert.deepEqual(appHosts({}), []);
});

const notFound = (e: unknown) => (e as { digest?: string }).digest === "NEXT_HTTP_ERROR_FALLBACK;404";
const headersOf = (h: Record<string, string>) => new Headers(h);

test("a request for an unknown host is Next's 404", () => {
  assert.throws(() => themeForHeaders(headersOf({ host: "evil.example.com" }), themes, opts), notFound);
  assert.throws(() => themeForHeaders(headersOf({ host: "nosuch.learn.forit.io" }), themes, opts), notFound);
});

test("a request's tenant comes from Host; a client-sent forwarded host neither switches tenant nor 404s", () => {
  assert.equal(themeForHeaders(headersOf({ host: "learn.forit.io" }), themes, opts, {}).slug, "forit");
  assert.equal(themeForHeaders(headersOf({ host: "learn.forit.io", "x-original-host": "charter.learn.forit.io" }), themes, opts, {}).slug, "forit");
  assert.equal(themeForHeaders(headersOf({ host: "learn.forit.io", "x-forwarded-host": "learn.operator.example" }), themes, opts, {}).slug, "forit");
  assert.equal(themeForHeaders(headersOf({ host: "charter.learn.forit.io", "x-forwarded-host": "evil.example.com" }), themes, opts, {}).slug, "charter");
  assert.equal(themeForHeaders(null, themes, opts, {}).slug, "forit");
  assert.equal(themeForHeaders(headersOf({ host: "evil.example.com" }), [], opts, {}), NEUTRAL_THEME);
});

test("with LMS_TRUST_FORWARDED_HOST the proxy's forwarded host picks the tenant", () => {
  const trust = { LMS_TRUST_FORWARDED_HOST: "true" };
  assert.equal(themeForHeaders(headersOf({ host: "lms:3000", "x-forwarded-host": "learn.operator.example" }), themes, opts, trust).slug, "operator");
  assert.throws(() => themeForHeaders(headersOf({ host: "learn.forit.io", "x-forwarded-host": "evil.example.com" }), themes, opts, trust), notFound);
});
