// One-shot setup for a self-hosted install (docker-compose.yml's `init`
// service). Safe to run on every start:
//   1. creates SQL_DATABASE if it is missing;
//   2. applies pending migrations (scripts/run-migration.cjs --pending);
//   3. creates or updates the app's own SQL login, LMS_APP_SQL_USER, with data
//      access to the lms schema, no DDL and no writes to the migration history;
//   4. when LMS_BOOTSTRAP_SLUG is set, creates that tenant and its first admin
//      (scripts/bootstrap-tenant.cjs).
// It signs in as SQL_USER, a server admin, and checks EXPECT_DB_USER as the
// migration runner does.
const { connect, pending } = require("./run-migration.cjs");
const { bootstrap } = require("./bootstrap-tenant.cjs");

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const BOOTSTRAP_OPTIONS = {
  LMS_BOOTSTRAP_SLUG: "--slug",
  LMS_BOOTSTRAP_NAME: "--name",
  LMS_BOOTSTRAP_AAD_TENANT_ID: "--aad-tenant-id",
  LMS_BOOTSTRAP_DOMAIN: "--domain",
  LMS_BOOTSTRAP_ADMIN_EMAIL: "--admin-email",
  LMS_BOOTSTRAP_HOSTNAME: "--hostname",
};

function bootstrapArgs(env) {
  if (!env.LMS_BOOTSTRAP_SLUG) return null;
  return Object.entries(BOOTSTRAP_OPTIONS).flatMap(([key, flag]) => (env[key] ? [flag, env[key]] : []));
}

function plan(env) {
  const database = env.SQL_DATABASE;
  if (!database || !NAME_RE.test(database)) throw new Error("SQL_DATABASE must be letters, digits and underscores");
  const appUser = env.LMS_APP_SQL_USER || null;
  if (appUser && !NAME_RE.test(appUser)) throw new Error("LMS_APP_SQL_USER must be letters, digits and underscores");
  if (appUser && !env.LMS_APP_SQL_PASSWORD) throw new Error("LMS_APP_SQL_PASSWORD is not set");
  if (appUser && appUser.toLowerCase() === (env.SQL_USER || "").toLowerCase()) {
    throw new Error("LMS_APP_SQL_USER must not be the admin login the setup signs in as");
  }
  return { database, appUser, bootstrap: bootstrapArgs(env) };
}

// EXEC() takes only literals and variables, so each statement is built in @s.
// The password is quoted by doubling its quotes: QUOTENAME returns NULL past
// 128 characters, and EXEC(NULL) does nothing.
const CREATE_DATABASE = `
IF DB_ID(@db) IS NULL
BEGIN
    DECLARE @s NVARCHAR(400) = N'CREATE DATABASE ' + QUOTENAME(@db);
    EXEC(@s);
END`;

const APP_LOGIN = `
DECLARE @pw NVARCHAR(MAX) = N'''' + REPLACE(@password, N'''', N'''''') + N'''';
DECLARE @s NVARCHAR(MAX) = CASE WHEN SUSER_ID(@user) IS NULL
    THEN N'CREATE LOGIN ' + QUOTENAME(@user) + N' WITH PASSWORD = ' + @pw + N', DEFAULT_DATABASE = ' + QUOTENAME(@db)
    ELSE N'ALTER LOGIN ' + QUOTENAME(@user) + N' WITH PASSWORD = ' + @pw END;
EXEC(@s);`;

const APP_USER = `
DECLARE @s NVARCHAR(MAX) = N'';
IF USER_ID(@user) IS NULL SET @s = N'CREATE USER ' + QUOTENAME(@user) + N' FOR LOGIN ' + QUOTENAME(@user) + N'; ';
SET @s = @s + N'GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON SCHEMA::lms TO ' + QUOTENAME(@user) + N'; '
    + N'DENY INSERT, UPDATE, DELETE ON lms.SchemaMigration TO ' + QUOTENAME(@user) + N';';
EXEC(@s);`;

async function init({ env = process.env, sql = require("mssql"), log = console.log } = {}) {
  const p = plan(env);
  const master = await connect({ env: { ...env, SQL_DATABASE: "master" }, sql, log });
  try {
    await master.pool.request().input("db", p.database).query(CREATE_DATABASE);
    if (p.appUser) {
      await master.pool.request().input("user", p.appUser).input("password", env.LMS_APP_SQL_PASSWORD).input("db", p.database).query(APP_LOGIN);
    }
  } finally {
    await master.pool.close();
  }
  log(`Database ${p.database} is ready.`);
  await pending({ env, sql, log });
  if (p.appUser) {
    const db = await connect({ env, sql, log });
    try {
      await db.pool.request().input("user", p.appUser).query(APP_USER);
    } finally {
      await db.pool.close();
    }
    log(`${p.appUser} may read and write the lms schema.`);
  }
  if (p.bootstrap) await bootstrap(p.bootstrap, { env, sql, log });
}

module.exports = { init, plan, bootstrapArgs };

if (require.main === module) {
  init().catch((err) => {
    console.error(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
