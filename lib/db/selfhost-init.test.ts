import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { init, plan, bootstrapArgs } = require("../../scripts/selfhost-init.cjs") as {
  init: (opts: { env: Record<string, string>; sql: unknown; log: (s: string) => void }) => Promise<void>;
  plan: (env: Record<string, string>) => { database: string; appUser: string | null; bootstrap: string[] | null };
  bootstrapArgs: (env: Record<string, string>) => string[] | null;
};

const env = {
  SQL_SERVER: "sql",
  SQL_DATABASE: "lms",
  SQL_USER: "sa",
  SQL_PASSWORD: "p",
  EXPECT_DB_USER: "dbo",
  LMS_APP_SQL_USER: "lms_app",
  LMS_APP_SQL_PASSWORD: "it's secret",
};

// Records each statement with the database it ran in and its parameters.
function fakeSql(dbUser = "dbo") {
  const steps: { db: string; what: string; inputs: Record<string, unknown> }[] = [];
  let historyTable = false;
  const history = new Map<string, string>();
  const connect = async (config: { database: string }) => {
    const db = config.database;
    return {
      request() {
        const inputs: Record<string, unknown> = {};
        const req = {
          input(name: string, value: unknown) {
            inputs[name] = value;
            return req;
          },
          async query(text: string) {
            if (text.includes("AS db_user")) return { recordset: [{ db_user: dbUser, lms_alter: 1, lms_references: 1, create_table: 1 }] };
            if (text.includes("AS has_history")) return { recordset: [{ has_history: historyTable ? 1 : 0, lms_tables: history.size }] };
            if (text.startsWith("SELECT Name, Checksum")) return { recordset: [...history].map(([Name, Checksum]) => ({ Name, Checksum })) };
            if (text.includes("MERGE lms.SchemaMigration")) {
              history.set(String(inputs.name), String(inputs.sum));
              return { recordset: [] };
            }
            const what = text.includes("CREATE DATABASE")
              ? "database"
              : text.includes("CREATE LOGIN")
                ? "login"
                : text.includes("CREATE USER")
                  ? "grant"
                  : text.includes("INSERT lms.Tenant")
                    ? "tenant"
                    : null;
            if (!what) throw new Error(`unexpected query: ${text.slice(0, 60)}`);
            steps.push({ db, what, inputs: { ...inputs } });
            const row = { TenantId: "t-1", Slug: inputs.slug, Name: inputs.name, AadTenantId: inputs.aad, CustomHostname: null, Created: true };
            return { recordset: what === "tenant" ? [row] : [] };
          },
          async batch(b: string) {
            if (b.includes("CREATE TABLE lms.SchemaMigration")) historyTable = true;
            else if (!steps.some((s) => s.what === "migrations")) steps.push({ db, what: "migrations", inputs: {} });
            return { rowsAffected: [] };
          },
        };
        return req;
      },
      close: async () => undefined,
    };
  };
  return { sql: { connect }, steps, history };
}

test("the first tenant's options come from LMS_BOOTSTRAP_*, only those set", () => {
  assert.equal(bootstrapArgs({ LMS_BOOTSTRAP_NAME: "Acme" }), null);
  assert.deepEqual(
    bootstrapArgs({ LMS_BOOTSTRAP_SLUG: "acme", LMS_BOOTSTRAP_NAME: "Acme Aviation", LMS_BOOTSTRAP_DOMAIN: "acme.example", LMS_BOOTSTRAP_HOSTNAME: "" }),
    ["--slug", "acme", "--name", "Acme Aviation", "--domain", "acme.example"],
  );
});

test("names that end up inside SQL text must be plain identifiers", () => {
  assert.throws(() => plan({ ...env, SQL_DATABASE: "" }), /SQL_DATABASE/);
  assert.throws(() => plan({ ...env, SQL_DATABASE: "lms]; DROP DATABASE master; --" }), /SQL_DATABASE/);
  assert.throws(() => plan({ ...env, LMS_APP_SQL_USER: "lms app" }), /LMS_APP_SQL_USER/);
  assert.throws(() => plan({ ...env, LMS_APP_SQL_PASSWORD: "" }), /LMS_APP_SQL_PASSWORD/);
  assert.throws(() => plan({ ...env, LMS_APP_SQL_USER: "SA" }), /must not be the admin login/);
  assert.deepEqual(plan({ ...env, LMS_APP_SQL_USER: "" }), { database: "lms", appUser: null, bootstrap: null });
});

test("creates the database and login in master, migrates, grants in the database, then bootstraps", async () => {
  const fake = fakeSql();
  await init({ env: { ...env, LMS_BOOTSTRAP_SLUG: "acme", LMS_BOOTSTRAP_NAME: "Acme", LMS_BOOTSTRAP_DOMAIN: "acme.example" }, sql: fake.sql, log: () => undefined });
  assert.deepEqual(
    fake.steps.map((s) => `${s.db}:${s.what}`),
    ["master:database", "master:login", "lms:migrations", "lms:grant", "lms:tenant"],
  );
  assert.deepEqual(fake.steps[0]?.inputs, { db: "lms" });
  assert.deepEqual(fake.steps[1]?.inputs, { user: "lms_app", password: "it's secret", db: "lms" });
  assert.ok(fake.history.size > 0);
});

test("without an app login or a tenant it only creates and migrates", async () => {
  const fake = fakeSql();
  await init({ env: { ...env, LMS_APP_SQL_USER: "" }, sql: fake.sql, log: () => undefined });
  assert.deepEqual(fake.steps.map((s) => s.what), ["database", "migrations"]);
});

test("bad settings or the wrong admin write nothing", async () => {
  const bad = fakeSql();
  await assert.rejects(init({ env: { ...env, SQL_DATABASE: "a-b" }, sql: bad.sql, log: () => undefined }), /SQL_DATABASE/);
  assert.equal(bad.steps.length, 0);
  const wrong = fakeSql("guest");
  await assert.rejects(init({ env, sql: wrong.sql, log: () => undefined }), /not dbo/);
  assert.equal(wrong.steps.length, 0);
});
