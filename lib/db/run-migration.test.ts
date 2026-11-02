import { mock, test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
type Opts = { env: Record<string, string>; sql: unknown; log: (s: string) => void; dir?: string };
const mig = require("../../scripts/run-migration.cjs") as {
  run: (file: string, opts: Opts) => Promise<{ ran: number }>;
  pending: (opts: Opts) => Promise<{ applied: string[] }>;
  baseline: (through: string, opts: Opts) => Promise<{ baselined: string[] }>;
  listMigrations: (dir?: string) => { name: string; file: string }[];
  splitBatches: (content: string) => string[];
  configFrom: (env: Record<string, string>) => Record<string, unknown> & { options: { trustServerCertificate: boolean } };
  checksum: (content: string) => string;
};

const FILE = "db/migrations/0019_mobile_device_key.sql";

// A pool that answers the runner's queries by their SQL text and keeps the
// history table in memory.
function fakeSql(dbUser: string, seed: { history?: Record<string, string>; lmsTables?: number } = {}) {
  const history = new Map(Object.entries(seed.history ?? {}));
  const modes = new Map<string, string>();
  const batches: string[] = [];
  let historyTable = history.size > 0;
  const pool = {
    request() {
      const inputs: Record<string, unknown> = {};
      const req = {
        input(name: string, value: unknown) {
          inputs[name] = value;
          return req;
        },
        async query(text: string) {
          if (text.includes("AS db_user")) {
            return { recordset: [{ db_user: dbUser, lms_alter: 1, lms_references: 1, create_table: 1 }] };
          }
          if (text.includes("AS has_history")) {
            return { recordset: [{ has_history: historyTable ? 1 : 0, lms_tables: seed.lmsTables ?? 0 }] };
          }
          if (text.startsWith("SELECT Name, Checksum FROM lms.SchemaMigration")) {
            return { recordset: [...history].map(([Name, Checksum]) => ({ Name, Checksum })) };
          }
          if (text.includes("MERGE lms.SchemaMigration")) {
            assert.ok(historyTable, "history written before its table was created");
            history.set(String(inputs.name), String(inputs.sum));
            modes.set(String(inputs.name), String(inputs.mode));
            return { recordset: [] };
          }
          throw new Error(`unexpected query: ${text.slice(0, 60)}`);
        },
        async batch(b: string) {
          if (b.includes("CREATE TABLE lms.SchemaMigration")) {
            historyTable = true;
            return { rowsAffected: [] };
          }
          batches.push(b);
          return { rowsAffected: [0] };
        },
      };
      return req;
    },
    close: async () => undefined,
  };
  return { sql: { connect: async () => pool }, batches, history, modes };
}

const env = { SQL_SERVER: "db", SQL_ACCESS_TOKEN: "t", EXPECT_DB_USER: "lms-migrate" };
const quiet = () => undefined;

// Three migration files, two batches each.
function migrationsDir() {
  const dir = mkdtempSync(join(tmpdir(), "lms-mig-"));
  for (const name of ["0001_base", "0002_more", "0003_last"]) {
    writeFileSync(join(dir, `${name}.sql`), `-- ${name}\nCREATE TABLE lms.T${name.slice(0, 4)} (Id INT)\nGO\nSELECT 1\n`);
  }
  writeFileSync(join(dir, "README.md"), "not a migration");
  return dir;
}
const sumOf = (name: string) => mig.checksum(`-- ${name}\nCREATE TABLE lms.T${name.slice(0, 4)} (Id INT)\nGO\nSELECT 1\n`);

test("GO on its own line splits batches; GO inside a word does not", () => {
  assert.deepEqual(mig.splitBatches("SELECT 1\nGO\n  go  \nSELECT 'GOOD'\n"), ["SELECT 1", "SELECT 'GOOD'"]);
});

test("runs every batch as the migrate identity and records the file", async () => {
  const fake = fakeSql("lms-migrate");
  const out = await mig.run(FILE, { env, sql: fake.sql, log: quiet });
  assert.equal(out.ran, fake.batches.length);
  assert.ok(fake.batches.length > 0);
  assert.equal(fake.modes.get("0019_mobile_device_key"), "applied");
  assert.match(fake.history.get("0019_mobile_device_key") ?? "", /^[0-9a-f]{64}$/);
});

test("a token for any other user runs and records nothing", async () => {
  const fake = fakeSql("lms_app");
  await assert.rejects(mig.run(FILE, { env, sql: fake.sql, log: quiet }), /not lms-migrate/);
  assert.equal(fake.batches.length, 0);
  assert.equal(fake.history.size, 0);
});

test("CHECK_ONLY connects and runs no batch", async () => {
  const fake = fakeSql("lms-migrate");
  const out = await mig.run(FILE, { env: { ...env, CHECK_ONLY: "1" }, sql: fake.sql, log: quiet });
  assert.equal(out.ran, 0);
  assert.equal(fake.batches.length, 0);
  assert.equal(fake.history.size, 0);
});

test("only db/migrations/NNNN_name.sql paths are accepted", async () => {
  const fake = fakeSql("lms-migrate");
  await assert.rejects(mig.run("/etc/passwd", { env, sql: fake.sql, log: quiet }), /not a db\/migrations/);
  await assert.rejects(
    mig.run("db/hosted-migrations/0016_charter_tenant.sql", { env, sql: fake.sql, log: quiet }),
    /not a db\/migrations/,
  );
});

test("--pending on an empty database applies every file in order and records each", async () => {
  const dir = migrationsDir();
  const fake = fakeSql("lms-migrate");
  const out = await mig.pending({ env, sql: fake.sql, log: quiet, dir });
  assert.deepEqual(out.applied, ["0001_base", "0002_more", "0003_last"]);
  assert.equal(fake.batches.length, 6);
  assert.match(fake.batches[0] ?? "", /0001_base/);
  assert.match(fake.batches[4] ?? "", /0003_last/);
  assert.deepEqual([...fake.modes.values()], ["applied", "applied", "applied"]);
  assert.equal(fake.history.get("0002_more"), sumOf("0002_more"));
});

test("files run in number order whatever order the directory lists them", () => {
  const listed = mock.method(fs, "readdirSync", () => ["0003_last.sql", "README.md", "0001_base.sql", "0002_more.sql", "0004_Bad.sql"]);
  try {
    assert.deepEqual(mig.listMigrations("db/migrations"), [
      { name: "0001_base", file: "db/migrations/0001_base.sql" },
      { name: "0002_more", file: "db/migrations/0002_more.sql" },
      { name: "0003_last", file: "db/migrations/0003_last.sql" },
    ]);
  } finally {
    listed.mock.restore();
  }
});

test("--pending runs only what isn't recorded", async () => {
  const dir = migrationsDir();
  const fake = fakeSql("lms-migrate", {
    history: { "0001_base": sumOf("0001_base"), "0002_more": sumOf("0002_more") },
    lmsTables: 2,
  });
  const out = await mig.pending({ env, sql: fake.sql, log: quiet, dir });
  assert.deepEqual(out.applied, ["0003_last"]);
  assert.equal(fake.batches.length, 2);
  const again = await mig.pending({ env, sql: fake.sql, log: quiet, dir });
  assert.deepEqual(again.applied, []);
  assert.equal(fake.batches.length, 2);
});

test("--pending refuses a database with lms tables and no history", async () => {
  const dir = migrationsDir();
  const fake = fakeSql("lms-migrate", { lmsTables: 30 });
  await assert.rejects(mig.pending({ env, sql: fake.sql, log: quiet, dir }), /30 lms tables but no migration history/);
  assert.equal(fake.batches.length, 0);
  assert.equal(fake.history.size, 0);
});

test("--pending refuses files older than the newest recorded", async () => {
  const dir = migrationsDir();
  const fake = fakeSql("lms-migrate", { history: { "0003_last": sumOf("0003_last") }, lmsTables: 30 });
  await assert.rejects(
    mig.pending({ env, sql: fake.sql, log: quiet, dir }),
    /0001_base, 0002_more are older than 0003/,
  );
  assert.equal(fake.batches.length, 0);
});

test("--pending notes a recorded file that changed and doesn't run it again", async () => {
  const dir = migrationsDir();
  const fake = fakeSql("lms-migrate", {
    history: { "0001_base": "0".repeat(64), "0002_more": sumOf("0002_more"), "0003_last": sumOf("0003_last") },
    lmsTables: 3,
  });
  const lines: string[] = [];
  const out = await mig.pending({ env, sql: fake.sql, log: (s) => lines.push(s), dir });
  assert.deepEqual(out.applied, []);
  assert.equal(fake.batches.length, 0);
  assert.ok(lines.some((l) => l.includes("0001_base has changed since it was recorded")));
});

test("--pending with CHECK_ONLY or the wrong user runs nothing", async () => {
  const dir = migrationsDir();
  const check = fakeSql("lms-migrate");
  assert.deepEqual((await mig.pending({ env: { ...env, CHECK_ONLY: "1" }, sql: check.sql, log: quiet, dir })).applied, []);
  assert.equal(check.batches.length, 0);
  const wrong = fakeSql("lms_app");
  await assert.rejects(mig.pending({ env, sql: wrong.sql, log: quiet, dir }), /not lms-migrate/);
  assert.equal(wrong.batches.length, 0);
});

test("--baseline-through records files up to that number without running them", async () => {
  const dir = migrationsDir();
  const fake = fakeSql("lms-migrate", { lmsTables: 30 });
  const out = await mig.baseline("0002", { env, sql: fake.sql, log: quiet, dir });
  assert.deepEqual(out.baselined, ["0001_base", "0002_more"]);
  assert.equal(fake.batches.length, 0);
  assert.deepEqual([...fake.modes.values()], ["baselined", "baselined"]);
  assert.equal(fake.history.get("0001_base"), sumOf("0001_base"));
  const rest = await mig.pending({ env, sql: fake.sql, log: quiet, dir });
  assert.deepEqual(rest.applied, ["0003_last"]);
});

test("--baseline-through keeps what is already recorded and writes nothing under CHECK_ONLY", async () => {
  const dir = migrationsDir();
  const fake = fakeSql("lms-migrate", { history: { "0001_base": sumOf("0001_base") }, lmsTables: 30 });
  const check = await mig.baseline("0003", { env: { ...env, CHECK_ONLY: "1" }, sql: fake.sql, log: quiet, dir });
  assert.deepEqual(check.baselined, []);
  assert.equal(fake.history.size, 1);
  const out = await mig.baseline("0003", { env, sql: fake.sql, log: quiet, dir });
  assert.deepEqual(out.baselined, ["0002_more", "0003_last"]);
  assert.equal(fake.modes.get("0001_base"), undefined);
});

test("--baseline-through needs a migration number that exists", async () => {
  const dir = migrationsDir();
  const fake = fakeSql("lms-migrate");
  await assert.rejects(mig.baseline("2", { env, sql: fake.sql, log: quiet, dir }), /four-digit migration number/);
  await assert.rejects(mig.baseline("0009", { env, sql: fake.sql, log: quiet, dir }), /no migration 0009/);
  assert.equal(fake.history.size, 0);
});

test("password sign-in needs server, user and password; only 'true' trusts a self-signed certificate", () => {
  assert.throws(() => mig.configFrom({ SQL_SERVER: "db", SQL_USER: "sa" }), /SQL_PASSWORD/);
  const pw = mig.configFrom({ SQL_SERVER: "db", SQL_USER: "sa", SQL_PASSWORD: "p", SQL_PORT: "14330" });
  assert.equal(pw.server, "db");
  assert.equal(pw.port, 14330);
  assert.equal(pw.database, "forit");
  assert.equal(pw.options.trustServerCertificate, false);
  const local = mig.configFrom({ SQL_SERVER: "db", SQL_USER: "sa", SQL_PASSWORD: "p", SQL_TRUST_SERVER_CERTIFICATE: "1" });
  assert.equal(local.options.trustServerCertificate, false);
  const trusted = mig.configFrom({ SQL_SERVER: "db", SQL_USER: "sa", SQL_PASSWORD: "p", SQL_TRUST_SERVER_CERTIFICATE: "true" });
  assert.equal(trusted.options.trustServerCertificate, true);
  assert.throws(() => mig.configFrom({ SQL_ACCESS_TOKEN: "t" }), /SQL_SERVER/);
  const token = mig.configFrom({ SQL_ACCESS_TOKEN: "t", SQL_SERVER: "db" });
  assert.equal(token.server, "db");
  assert.equal(token.user, undefined);
});
