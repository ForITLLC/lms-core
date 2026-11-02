import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
type Tenant = { slug: string; name: string; aad: string | null; domain: string | null; adminEmail: string | null; hostname: string | null };
const { bootstrap, validate, parseArgs } = require("../../scripts/bootstrap-tenant.cjs") as {
  bootstrap: (argv: string[], opts: { env: Record<string, string>; sql: unknown; log: (s: string) => void }) => Promise<Record<string, unknown> | null>;
  validate: (args: Record<string, string>) => Tenant;
  parseArgs: (argv: string[]) => Record<string, string>;
};

const AAD = "11111111-2222-3333-4444-555555555555";
const env = { SQL_SERVER: "db", SQL_ACCESS_TOKEN: "t", EXPECT_DB_USER: "lms-migrate" };

function fakeSql(dbUser: string) {
  const writes: Record<string, unknown>[] = [];
  const pool = {
    request() {
      const inputs: Record<string, unknown> = {};
      const req = {
        input(name: string, value: unknown) {
          inputs[name] = value;
          return req;
        },
        async query(text: string) {
          if (text.includes("AS db_user")) return { recordset: [{ db_user: dbUser, lms_alter: 1, lms_references: 1, create_table: 1 }] };
          if (text.includes("INSERT lms.Tenant")) {
            writes.push(inputs);
            return { recordset: [{ TenantId: "t-1", Slug: inputs.slug, Name: inputs.name, AadTenantId: inputs.aad, CustomHostname: inputs.hostname, Created: true }] };
          }
          throw new Error(`unexpected query: ${text.slice(0, 60)}`);
        },
      };
      return req;
    },
    close: async () => undefined,
  };
  return { sql: { connect: async () => pool }, writes };
}

test("options are --name value pairs", () => {
  assert.deepEqual(parseArgs(["--slug", "acme", "--name", "Acme"]), { slug: "acme", name: "Acme" });
  assert.throws(() => parseArgs(["--slug"]), /--name value pairs/);
  assert.throws(() => parseArgs(["slug", "acme"]), /--name value pairs/);
});

test("a tenant needs a directory or an email domain, or nobody can sign in", () => {
  assert.throws(() => validate({ slug: "acme", name: "Acme" }), /--aad-tenant-id or --domain/);
  assert.equal(validate({ slug: "acme", name: "Acme", "aad-tenant-id": AAD }).aad, AAD);
  assert.equal(validate({ slug: "acme", name: "Acme", domain: "Acme.Example" }).domain, "acme.example");
});

test("bad slugs, directory ids, domains, emails, host names and unknown options are refused", () => {
  const ok = { slug: "acme", name: "Acme", "aad-tenant-id": AAD };
  assert.throws(() => validate({ ...ok, slug: "-acme" }), /--slug/);
  assert.throws(() => validate({ ...ok, slug: "acme corp" }), /--slug/);
  assert.throws(() => validate({ ...ok, name: "  " }), /--name/);
  assert.throws(() => validate({ ...ok, "aad-tenant-id": "acme" }), /GUID/);
  assert.throws(() => validate({ ...ok, domain: "acme" }), /--domain/);
  assert.throws(() => validate({ ...ok, "admin-email": "ops" }), /--admin-email/);
  assert.throws(() => validate({ ...ok, hostname: "https://learn.acme.example" }), /--hostname/);
  assert.throws(() => validate({ ...ok, role: "admin" }), /unknown option --role/);
});

test("names are lowercased where the app compares them lowercased", () => {
  const t = validate({
    slug: "Acme",
    name: " Acme Aviation ",
    "aad-tenant-id": AAD.toUpperCase(),
    "admin-email": "Ops@Acme.Example",
    hostname: "Learn.Acme.Example",
  });
  assert.deepEqual(t, { slug: "acme", name: "Acme Aviation", aad: AAD, domain: null, adminEmail: "ops@acme.example", hostname: "learn.acme.example" });
});

test("bootstrap writes the validated values as parameters", async () => {
  const fake = fakeSql("lms-migrate");
  const row = await bootstrap(["--slug", "acme", "--name", "Acme", "--domain", "acme.example", "--admin-email", "Ops@acme.example"], {
    env,
    sql: fake.sql,
    log: () => undefined,
  });
  assert.equal(row?.Created, true);
  assert.deepEqual(fake.writes, [{ slug: "acme", name: "Acme", aad: null, domain: "acme.example", adminEmail: "ops@acme.example", hostname: null }]);
});

test("bootstrap writes nothing under CHECK_ONLY, as the wrong user, or with bad options", async () => {
  const args = ["--slug", "acme", "--name", "Acme", "--aad-tenant-id", AAD];
  const check = fakeSql("lms-migrate");
  assert.equal(await bootstrap(args, { env: { ...env, CHECK_ONLY: "1" }, sql: check.sql, log: () => undefined }), null);
  assert.equal(check.writes.length, 0);
  const wrong = fakeSql("lms_app");
  await assert.rejects(bootstrap(args, { env, sql: wrong.sql, log: () => undefined }), /not lms-migrate/);
  assert.equal(wrong.writes.length, 0);
  const bad = fakeSql("lms-migrate");
  await assert.rejects(bootstrap(["--slug", "acme", "--name", "Acme"], { env, sql: bad.sql, log: () => undefined }), /--aad-tenant-id or --domain/);
  assert.equal(bad.writes.length, 0);
});
