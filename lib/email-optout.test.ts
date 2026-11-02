import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as mail from "./vendor/mail";
import { createMemoryOptOutStore, createUnsubscribeRouteHandler } from "./vendor/mail";
import * as optout from "./email-optout";
import { addressPepperFromEnv, LEARNING_SUMMARY, MAIL_PURPOSE, optOutSubject, preferencesUrl, tenantOrigin, unsubscribeKeyringFromEnv, unsubscribeUrl } from "./email-optout";

const KEY = "k".repeat(48);
const PEPPER = "p".repeat(48);
const TENANT = "6F9619FF-8B86-D011-B42D-00CF4FC964FF";

test("keyring: none configured is null; current key signs; unresolved Key Vault references are refused", () => {
  assert.equal(unsubscribeKeyringFromEnv({}), null);
  const keyring = unsubscribeKeyringFromEnv({ EMAIL_UNSUBSCRIBE_KEY_K2026: KEY, EMAIL_UNSUBSCRIBE_CURRENT_KEY: "K2026" });
  assert.equal(keyring?.current, "k2026");
  assert.equal(keyring?.keys.k2026, KEY);
  assert.throws(() => unsubscribeKeyringFromEnv({ EMAIL_UNSUBSCRIBE_KEY_K2026: "@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/x)", EMAIL_UNSUBSCRIBE_CURRENT_KEY: "k2026" }), /unresolved Key Vault/);
  assert.equal(addressPepperFromEnv({}), null);
  assert.throws(() => addressPepperFromEnv({ EMAIL_ADDRESS_PEPPER: " @Microsoft.KeyVault(VaultName=kv;SecretName=p)" }), /unresolved Key Vault/);
});

test("the opt-out subject never carries the address and ignores tenant id and address case", () => {
  const who = optOutSubject(TENANT, "Pat.Example@Operator.test", PEPPER);
  assert.equal(who.tenant, TENANT.toLowerCase());
  assert.doesNotMatch(who.subject, /pat|example|operator/i);
  assert.deepEqual(optOutSubject(TENANT.toLowerCase(), "pat.example@operator.test", PEPPER), who);
  assert.notDeepEqual(optOutSubject("other-tenant", "pat.example@operator.test", PEPPER), who);
});

test("tenant links stay on the tenant's own host", () => {
  assert.equal(tenantOrigin({ slug: "operator", customHostname: "learn.operator.example" }), "https://learn.operator.example");
  assert.equal(tenantOrigin({ slug: "charter", customHostname: null }), "https://charter.learn.forit.io");
  assert.equal(preferencesUrl("https://learn.operator.example"), "https://learn.operator.example/dashboard/settings");
});

test("a tenant without its own host gets a subdomain of the configured apex", () => {
  const before = process.env.LMS_APEX_DOMAIN;
  process.env.LMS_APEX_DOMAIN = "learn.example.org";
  try {
    assert.equal(tenantOrigin({ slug: "charter", customHostname: null }), "https://charter.learn.example.org");
  } finally {
    if (before === undefined) delete process.env.LMS_APEX_DOMAIN;
    else process.env.LMS_APEX_DOMAIN = before;
  }
});

test("the apex tenant's links go to the apex, which is the only host that serves it", () => {
  const before = { domain: process.env.LMS_APEX_DOMAIN, slug: process.env.LMS_APEX_TENANT_SLUG };
  try {
    delete process.env.LMS_APEX_DOMAIN;
    delete process.env.LMS_APEX_TENANT_SLUG;
    assert.equal(tenantOrigin({ slug: "forit", customHostname: null }), "https://learn.forit.io");
    assert.equal(tenantOrigin({ slug: "ForIT ", customHostname: null }), "https://learn.forit.io");
    assert.equal(tenantOrigin({ slug: "forit", customHostname: "learn.forit.example" }), "https://learn.forit.example");
    process.env.LMS_APEX_DOMAIN = "learn.example.org";
    process.env.LMS_APEX_TENANT_SLUG = "home";
    assert.equal(tenantOrigin({ slug: "home", customHostname: null }), "https://learn.example.org");
    assert.equal(tenantOrigin({ slug: "forit", customHostname: null }), "https://forit.learn.example.org");
  } finally {
    for (const [name, value] of [["LMS_APEX_DOMAIN", before.domain], ["LMS_APEX_TENANT_SLUG", before.slug]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("the email's one-click link and the account switch flip the same row", async () => {
  const keyring = unsubscribeKeyringFromEnv({ EMAIL_UNSUBSCRIBE_KEY_K1: KEY, EMAIL_UNSUBSCRIBE_CURRENT_KEY: "k1" })!;
  const store = createMemoryOptOutStore();
  const route = createUnsubscribeRouteHandler({ keyring, purpose: MAIL_PURPOSE, store, page: { productName: "Operator Learning" } });
  const who = optOutSubject(TENANT, "pat@operator.test", PEPPER);
  const url = unsubscribeUrl("https://learn.operator.test", keyring, who, LEARNING_SUMMARY);
  assert.match(url, /^https:\/\/learn\.operator\.test\/api\/unsubscribe\?t=/);

  const asked = await route.GET(new Request(url));
  assert.equal(asked.status, 200);
  assert.equal(await store.isOff(who, LEARNING_SUMMARY), false, "GET only asks");

  const oneClick = await route.POST(new Request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }));
  assert.equal(oneClick.status, 200);
  assert.equal(await store.isOff(optOutSubject(TENANT.toLowerCase(), "PAT@operator.test", PEPPER), LEARNING_SUMMARY), true);
  assert.deepEqual((await store.list(who)).map(entry => entry.category), [LEARNING_SUMMARY]);

  await store.setOn(who, LEARNING_SUMMARY, "account");
  assert.equal(await store.isOff(who, LEARNING_SUMMARY), false);
});

test("a link minted for another tenant's learner does not switch this one off", async () => {
  const keyring = unsubscribeKeyringFromEnv({ EMAIL_UNSUBSCRIBE_KEY_K1: KEY, EMAIL_UNSUBSCRIBE_CURRENT_KEY: "k1" })!;
  const store = createMemoryOptOutStore();
  const route = createUnsubscribeRouteHandler({ keyring, purpose: MAIL_PURPOSE, store, page: { productName: "Operator Learning" } });
  const other = optOutSubject("other-tenant", "pat@operator.test", PEPPER);
  const url = unsubscribeUrl("https://learn.operator.test", keyring, other, LEARNING_SUMMARY);
  await route.POST(new Request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }));
  assert.equal(await store.isOff(optOutSubject(TENANT, "pat@operator.test", PEPPER), LEARNING_SUMMARY), false);
  assert.equal(await store.isOff(other, LEARNING_SUMMARY), true);
});

function unsubscribeRoute(env: Record<string, string>) {
  const store = createMemoryOptOutStore();
  const errors: string[] = [];
  const modules: Record<string, unknown> = {
    "@/lib/vendor/mail": mail,
    "@/lib/logging": { recordError: async (_service: string, message: string) => { errors.push(message); } },
    "@/lib/email-optout": { ...optout, optOutStore: () => store, unsubscribeKeyringFromEnv: () => optout.unsubscribeKeyringFromEnv(env),
      unsubscribePage: async () => ({ productName: "Operator Learning", accountUrl: "https://learn.operator.test/dashboard/settings" }) },
  };
  const code = ts.transpileModule(readFileSync(new URL("../app/api/unsubscribe/route.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, Error, Response, require: (id: string) => { if (!(id in modules)) throw new Error(id); return modules[id]; } });
  return { GET: exports.GET as (request: Request) => Promise<Response>, POST: exports.POST as (request: Request) => Promise<Response>, store, errors };
}

const oneClick = (url: string) => new Request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });

test("the unsubscribe route answers 503 and changes nothing with no key or an unresolved Key Vault reference", async () => {
  const none = unsubscribeRoute({});
  assert.equal((await none.GET(new Request("https://learn.operator.test/api/unsubscribe?t=x"))).status, 503);
  assert.equal((await none.POST(oneClick("https://learn.operator.test/api/unsubscribe?t=x"))).status, 503);
  assert.deepEqual(none.errors, []);
  const unresolved = unsubscribeRoute({ EMAIL_UNSUBSCRIBE_KEY_K1: "@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/k1)", EMAIL_UNSUBSCRIBE_CURRENT_KEY: "k1" });
  assert.equal((await unresolved.GET(new Request("https://learn.operator.test/api/unsubscribe?t=x"))).status, 503);
  assert.match(unresolved.errors[0]!, /unresolved Key Vault reference/);
});

test("the app's unsubscribe route: GET asks, one-click POST switches the summary off for that learner only", async () => {
  const env = { EMAIL_UNSUBSCRIBE_KEY_K1: KEY, EMAIL_UNSUBSCRIBE_CURRENT_KEY: "k1" };
  const app = unsubscribeRoute(env);
  const who = optOutSubject(TENANT, "pat@operator.test", PEPPER);
  const url = unsubscribeUrl("https://learn.operator.test", unsubscribeKeyringFromEnv(env)!, who, LEARNING_SUMMARY);
  const page = await app.GET(new Request(url));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Operator Learning/);
  assert.equal(await app.store.isOff(who, LEARNING_SUMMARY), false);
  assert.equal((await app.POST(oneClick(url))).status, 200);
  assert.equal(await app.store.isOff(who, LEARNING_SUMMARY), true);
  assert.equal(await app.store.isOff(optOutSubject(TENANT, "sam@operator.test", PEPPER), LEARNING_SUMMARY), false);
  assert.equal((await app.POST(oneClick("https://learn.operator.test/api/unsubscribe?t=forged"))).status, 400);
});
