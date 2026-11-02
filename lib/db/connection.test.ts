import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionConfig, loggingEnv, query, execute, executeLogging } from "./connection";

const BASE = { SQL_SERVER: "sql.example.org", SQL_DATABASE: "lms" };
const LOGIN = { SQL_USER: "lms_app", SQL_PASSWORD: "not-a-real-password" };
const APP_REG_ID = "11111111-1111-4111-8111-111111111111";
const UAMI_ID = "22222222-2222-4222-8222-222222222222";

function auth(env: Record<string, string>) {
  return connectionConfig(env).authentication as { type: string; options: Record<string, unknown> };
}

test("a login signs in with it, encrypted and checking the server certificate", () => {
  const config = connectionConfig({ ...BASE, ...LOGIN });
  assert.equal(config.server, "sql.example.org");
  assert.deepEqual(config.authentication, { type: "default", options: { userName: "lms_app", password: "not-a-real-password" } });
  assert.equal(config.options?.database, "lms");
  assert.equal(config.options?.encrypt, true);
  assert.equal(config.options?.trustServerCertificate, false);
  assert.equal(config.options?.rowCollectionOnRequestCompletion, true);
});

test("a missing server or database throws, naming it, and never falls back to a default", () => {
  assert.throws(() => connectionConfig({ ...LOGIN }), /^Error: SQL_SERVER and SQL_DATABASE not set/);
  assert.throws(() => connectionConfig({ ...LOGIN, SQL_DATABASE: "lms" }), /^Error: SQL_SERVER not set/);
  assert.throws(() => connectionConfig({ ...LOGIN, SQL_SERVER: "sql.example.org" }), /^Error: SQL_DATABASE not set/);
  assert.throws(() => connectionConfig({ ...LOGIN, SQL_DATABASE: "lms", SQL_AUTH: "managed-identity" }), /SQL_SERVER not set/);
});

test("a missing login throws, naming what is missing", () => {
  assert.throws(() => connectionConfig({ ...BASE }), /SQL_USER and SQL_PASSWORD not set; refusing to connect without a SQL login/);
  assert.throws(() => connectionConfig({ ...BASE, SQL_PASSWORD: "x" }), /^Error: SQL_USER not set/);
  assert.throws(() => connectionConfig({ ...BASE, SQL_USER: "lms_app" }), /^Error: SQL_PASSWORD not set/);
  assert.throws(() => connectionConfig({ ...BASE, SQL_AUTH: "password" }), /SQL_USER and SQL_PASSWORD/);
});

test("managed-identity signs in as the app's identity and ignores a leftover login", () => {
  const a = auth({ ...BASE, ...LOGIN, SQL_AUTH: " Managed-Identity " });
  assert.deepEqual(a, { type: "azure-active-directory-msi-app-service", options: {} });
});

test("an unknown SQL_AUTH throws instead of falling back to a password login", () => {
  assert.throws(() => connectionConfig({ ...BASE, ...LOGIN, SQL_AUTH: "managed_identity" }), /SQL_AUTH must be 'password' or 'managed-identity', not 'managed_identity'/);
});

test("only SQL_MANAGED_IDENTITY_CLIENT_ID picks a user-assigned identity, never the Graph app's AZURE_CLIENT_ID", () => {
  const mi = { ...BASE, SQL_AUTH: "managed-identity" };
  assert.deepEqual(auth({ ...mi, AZURE_CLIENT_ID: APP_REG_ID }).options, {});
  assert.deepEqual(auth({ ...mi, AZURE_CLIENT_ID: APP_REG_ID, SQL_MANAGED_IDENTITY_CLIENT_ID: UAMI_ID }).options, { clientId: UAMI_ID });
});

test("query and execute reject before connecting when the settings are incomplete", async () => {
  const keys = ["SQL_SERVER", "SQL_DATABASE", "SQL_USER", "SQL_PASSWORD", "SQL_AUTH"] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  for (const k of keys) delete process.env[k];
  try {
    await assert.rejects(query("SELECT 1"), /SQL_SERVER and SQL_DATABASE not set/);
    await assert.rejects(execute("SELECT 1"), /SQL_SERVER and SQL_DATABASE not set/);
  } finally {
    for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
  }
});

test("SQL_PORT, when set, picks the port; unset or blank leaves the driver's default", () => {
  assert.equal(connectionConfig({ ...BASE, ...LOGIN, SQL_PORT: "14634" }).options?.port, 14634);
  assert.equal(connectionConfig({ ...BASE, ...LOGIN, SQL_PORT: " 1433 " }).options?.port, 1433);
  assert.equal("port" in (connectionConfig({ ...BASE, ...LOGIN }).options ?? {}), false);
  assert.equal("port" in (connectionConfig({ ...BASE, ...LOGIN, SQL_PORT: " " }).options ?? {}), false);
});

test("a SQL_PORT that isn't a port number throws instead of connecting somewhere else", () => {
  for (const bad of ["0", "65536", "14.5", "-1", "1433x", "0x59a"]) {
    assert.throws(() => connectionConfig({ ...BASE, ...LOGIN, SQL_PORT: bad }), new RegExp(`SQL_PORT must be a port number from 1 to 65535, not '${bad}'`));
  }
});

test("logging records stay in the app's database unless both LOGGING_SQL_* settings are set", () => {
  const env = { ...BASE, ...LOGIN, SQL_PORT: "14634" };
  assert.equal(loggingEnv(env), env);
  const split = connectionConfig(loggingEnv({ ...env, LOGGING_SQL_SERVER: "sql-platform.example.org", LOGGING_SQL_DATABASE: "forit" }));
  assert.equal(split.server, "sql-platform.example.org");
  assert.equal(split.options?.database, "forit");
  assert.equal("port" in (split.options ?? {}), false);
  assert.deepEqual(split.authentication, connectionConfig(env).authentication);
  const ported = loggingEnv({ ...env, LOGGING_SQL_SERVER: "s", LOGGING_SQL_DATABASE: "d", LOGGING_SQL_PORT: "1444" });
  assert.equal(connectionConfig(ported).options?.port, 1444);
});

test("logging to another database signs in as the same managed identity", () => {
  const mi = { ...BASE, SQL_AUTH: "managed-identity", SQL_MANAGED_IDENTITY_CLIENT_ID: UAMI_ID };
  const split = connectionConfig(loggingEnv({ ...mi, LOGGING_SQL_SERVER: "s", LOGGING_SQL_DATABASE: "forit" }));
  assert.deepEqual(split.authentication, { type: "azure-active-directory-msi-app-service", options: { clientId: UAMI_ID } });
});

test("one LOGGING_SQL_* setting without the other throws, naming the missing one", () => {
  assert.throws(() => loggingEnv({ ...BASE, LOGGING_SQL_SERVER: "s" }), /^Error: LOGGING_SQL_DATABASE not set; refusing to guess/);
  assert.throws(() => loggingEnv({ ...BASE, LOGGING_SQL_DATABASE: "forit" }), /^Error: LOGGING_SQL_SERVER not set; refusing to guess/);
});

test("executeLogging rejects before connecting when only one LOGGING_SQL_* setting is present", async () => {
  const keys = ["LOGGING_SQL_SERVER", "LOGGING_SQL_DATABASE"] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  delete process.env.LOGGING_SQL_DATABASE;
  process.env.LOGGING_SQL_SERVER = "sql-platform.example.org";
  try {
    await assert.rejects(executeLogging("SELECT 1"), /LOGGING_SQL_DATABASE not set/);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
