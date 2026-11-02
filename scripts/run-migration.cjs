// Applies db/migrations/*.sql and records each one in lms.SchemaMigration.
//
//   node scripts/run-migration.cjs db/migrations/0019_mobile_device_key.sql   one file
//   node scripts/run-migration.cjs --pending                                  every file not yet recorded, in order
//   node scripts/run-migration.cjs --baseline-through 0027                     record files up to 0027 as already applied, running none
//
// Sign-in: SQL_SERVER plus SQL_ACCESS_TOKEN (an Entra token for
// https://database.windows.net/) or SQL_USER + SQL_PASSWORD. SQL_PORT and SQL_DATABASE are
// optional; SQL_TRUST_SERVER_CERTIFICATE=true accepts a self-signed server
// certificate (a local container), and nothing else does.
//
// A hosted deploy (ForIT's is .github/workflows/deploy.yml) signs in to Azure
// as a migration identity with DDL rights and passes its token. The app's own
// identity (lms_app) has no DDL, by design.
//
// Nothing runs unless USER_NAME() is EXPECT_DB_USER, so a credential for the
// wrong user can't apply a migration. CHECK_ONLY=1 connects, prints the user,
// what it may do in the lms schema and what would run, and writes nothing.
//
// --pending refuses a database migrated before the history table existed: lms
// tables with no history, or files older than the newest one recorded. Its
// files would run again, and some change data. Record what it has with
// --baseline-through first.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DIR = "db/migrations";
const NAME_RE = /^db\/migrations\/[0-9]{4}_[a-z0-9_]+\.sql$/;

/** GO on its own line separates batches (case-insensitive). */
function splitBatches(content) {
  return content
    .split(/^\s*GO\s*$/im)
    .map((b) => b.trim())
    .filter(Boolean);
}

function checksum(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/** Every migration file, in order: [{ name: "0001_lms_schema", file: "db/migrations/0001_lms_schema.sql" }]. */
function listMigrations(dir = DIR) {
  return fs
    .readdirSync(path.resolve(dir))
    .filter((f) => /^[0-9]{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => ({ name: f.slice(0, -4), file: `${dir}/${f}` }));
}

function configFrom(env) {
  const options = { encrypt: true, trustServerCertificate: env.SQL_TRUST_SERVER_CERTIFICATE === "true" };
  const base = { database: env.SQL_DATABASE || "forit", options };
  if (env.SQL_PORT) base.port = Number(env.SQL_PORT);
  if (!env.SQL_SERVER) throw new Error("Set SQL_SERVER");
  if (env.SQL_ACCESS_TOKEN) {
    return {
      ...base,
      server: env.SQL_SERVER,
      authentication: { type: "azure-active-directory-access-token", options: { token: env.SQL_ACCESS_TOKEN } },
    };
  }
  if (!env.SQL_USER || !env.SQL_PASSWORD) {
    throw new Error("Set SQL_ACCESS_TOKEN, or SQL_USER and SQL_PASSWORD");
  }
  return { ...base, server: env.SQL_SERVER, user: env.SQL_USER, password: env.SQL_PASSWORD };
}

/** Connects and checks the user; the caller closes the pool. */
async function connect({ env, sql, log }) {
  if (!env.EXPECT_DB_USER) throw new Error("EXPECT_DB_USER is not set");
  const config = configFrom(env);
  log(`Connecting to ${config.server}/${config.database}...`);
  const pool = await sql.connect(config);
  const who = (
    await pool
      .request()
      .query(
        "SELECT USER_NAME() AS db_user, " +
          "HAS_PERMS_BY_NAME('lms', 'SCHEMA', 'ALTER') AS lms_alter, " +
          "HAS_PERMS_BY_NAME('lms', 'SCHEMA', 'REFERENCES') AS lms_references, " +
          "HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE') AS create_table",
      )
  ).recordset[0];
  log(
    `Connected as ${who.db_user}: lms ALTER=${who.lms_alter} REFERENCES=${who.lms_references}, ` +
      `CREATE TABLE=${who.create_table}`,
  );
  if (who.db_user !== env.EXPECT_DB_USER) {
    await pool.close();
    throw new Error(`connected as ${who.db_user}, not ${env.EXPECT_DB_USER}; nothing was run`);
  }
  return { pool, who };
}

const HISTORY_DDL = `IF SCHEMA_ID('lms') IS NULL EXEC('CREATE SCHEMA lms');
IF OBJECT_ID('lms.SchemaMigration', 'U') IS NULL
CREATE TABLE lms.SchemaMigration (
    Name      NVARCHAR(128) NOT NULL CONSTRAINT PK_lms_SchemaMigration PRIMARY KEY,
    Checksum  CHAR(64)      NOT NULL,
    Mode      NVARCHAR(16)  NOT NULL CONSTRAINT CK_lms_SchemaMigration_Mode CHECK (Mode IN ('applied', 'baselined')),
    AppliedAt DATETIME2(3)  NOT NULL CONSTRAINT DF_lms_SchemaMigration_At DEFAULT (SYSUTCDATETIME()),
    AppliedBy NVARCHAR(128) NOT NULL CONSTRAINT DF_lms_SchemaMigration_By DEFAULT (USER_NAME())
);`;

/** What the database has recorded, and whether it holds lms tables at all. */
async function readHistory(pool) {
  const { recordset } = await pool
    .request()
    .query(
      "SELECT CASE WHEN OBJECT_ID('lms.SchemaMigration', 'U') IS NULL THEN 0 ELSE 1 END AS has_history, " +
        "(SELECT COUNT(*) FROM sys.tables WHERE schema_id = SCHEMA_ID('lms') AND name <> 'SchemaMigration') AS lms_tables",
    );
  const { has_history, lms_tables } = recordset[0];
  const applied = new Map();
  if (has_history) {
    for (const row of (await pool.request().query("SELECT Name, Checksum FROM lms.SchemaMigration")).recordset) {
      applied.set(row.Name, row.Checksum);
    }
  }
  return { applied, lmsTables: lms_tables };
}

async function record(pool, name, sum, mode) {
  await pool.request().batch(HISTORY_DDL);
  await pool
    .request()
    .input("name", name)
    .input("sum", sum)
    .input("mode", mode)
    .query(
      `MERGE lms.SchemaMigration AS t
       USING (SELECT @name AS Name) AS s ON t.Name = s.Name
       WHEN MATCHED THEN UPDATE SET Checksum = @sum, Mode = @mode, AppliedAt = SYSUTCDATETIME(), AppliedBy = USER_NAME()
       WHEN NOT MATCHED THEN INSERT (Name, Checksum, Mode) VALUES (@name, @sum, @mode);`,
    );
}

async function applyOne(pool, { name, file }, log) {
  const content = fs.readFileSync(path.resolve(file), "utf8");
  const batches = splitBatches(content);
  for (let i = 0; i < batches.length; i++) {
    log(`  Batch ${i + 1}/${batches.length}...`);
    const res = await pool.request().batch(batches[i]);
    const affected = (res.rowsAffected || []).reduce((a, b) => a + b, 0);
    if (affected) log(`    rows affected: ${affected}`);
  }
  await record(pool, name, checksum(content), "applied");
  log(`Applied ${file}: ${batches.length} batches.`);
  return batches.length;
}

async function run(file, { env = process.env, sql = require("mssql"), log = console.log } = {}) {
  if (!NAME_RE.test(file)) throw new Error(`${file} is not a db/migrations/NNNN_name.sql path`);
  const batches = splitBatches(fs.readFileSync(path.resolve(file), "utf8"));
  const { pool, who } = await connect({ env, sql, log });
  try {
    if (env.CHECK_ONLY === "1") {
      log(`Check only: ${batches.length} batches in ${file}, none run.`);
      return { ran: 0, who };
    }
    const ran = await applyOne(pool, { name: path.basename(file, ".sql"), file }, log);
    return { ran, who };
  } finally {
    await pool.close();
  }
}

async function pending({ env = process.env, sql = require("mssql"), log = console.log, dir = DIR } = {}) {
  const all = listMigrations(dir);
  const { pool, who } = await connect({ env, sql, log });
  try {
    const { applied, lmsTables } = await readHistory(pool);
    if (applied.size === 0 && lmsTables > 0) {
      throw new Error(
        `this database has ${lmsTables} lms tables but no migration history; ` +
          "record what it already has with --baseline-through NNNN first. Nothing was run.",
      );
    }
    for (const m of all) {
      const sum = applied.get(m.name);
      if (sum && sum !== checksum(fs.readFileSync(path.resolve(m.file), "utf8"))) {
        log(`Note: ${m.name} has changed since it was recorded; it is not run again.`);
      }
    }
    const todo = all.filter((m) => !applied.has(m.name));
    const newest = [...applied.keys()].map((n) => n.slice(0, 4)).sort().pop();
    const older = newest ? todo.filter((m) => m.name.slice(0, 4) < newest) : [];
    if (older.length) {
      throw new Error(
        `${older.map((m) => m.name).join(", ")} ${older.length === 1 ? "is" : "are"} older than ${newest}, the newest recorded; ` +
          "this database was migrated before its history began, or out of order. Record them with --baseline-through, " +
          "or apply one by name. Nothing was run.",
      );
    }
    log(`${applied.size} recorded, ${todo.length} pending${todo.length ? `: ${todo.map((m) => m.name).join(", ")}` : ""}.`);
    if (env.CHECK_ONLY === "1") return { applied: [], who };
    for (const m of todo) await applyOne(pool, m, log);
    return { applied: todo.map((m) => m.name), who };
  } finally {
    await pool.close();
  }
}

async function baseline(through, { env = process.env, sql = require("mssql"), log = console.log, dir = DIR } = {}) {
  if (!/^[0-9]{4}$/.test(through || "")) throw new Error("--baseline-through needs a four-digit migration number, like 0027");
  const all = listMigrations(dir);
  if (!all.some((m) => m.name.startsWith(`${through}_`))) throw new Error(`no migration ${through} in ${dir}`);
  const { pool, who } = await connect({ env, sql, log });
  try {
    const { applied } = await readHistory(pool);
    const todo = all.filter((m) => m.name.slice(0, 4) <= through && !applied.has(m.name));
    log(`Baseline through ${through}: ${todo.length} to record, none run.`);
    if (env.CHECK_ONLY === "1") return { baselined: [], who };
    for (const m of todo) await record(pool, m.name, checksum(fs.readFileSync(path.resolve(m.file), "utf8")), "baselined");
    return { baselined: todo.map((m) => m.name), who };
  } finally {
    await pool.close();
  }
}

module.exports = { run, pending, baseline, splitBatches, configFrom, connect, listMigrations, checksum };

if (require.main === module) {
  const [arg, value] = process.argv.slice(2);
  const job = arg === "--pending" ? pending() : arg === "--baseline-through" ? baseline(value) : run(arg || "");
  job.catch((err) => {
    console.error(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
