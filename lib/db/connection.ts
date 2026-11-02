// The app's SQL Server connection, from SQL_*: one tedious connection per
// statement, closed when it finishes. A missing server, database or login throws
// before anything connects, so a half-configured app never guesses a server or
// sends a doomed sign-in.
import { Connection, Request, TYPES } from "tedious";
import type { ConnectionConfiguration } from "tedious";

export { TYPES };

export type SqlAuth = "password" | "managed-identity";

export interface QueryParam {
  name: string;
  type: (typeof TYPES)[keyof typeof TYPES];
  value: unknown;
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

type Env = Record<string, string | undefined>;

export function sqlAuth(env: Env): SqlAuth {
  const raw = env.SQL_AUTH;
  const mode = (raw ?? "").trim().toLowerCase() || "password";
  if (mode === "password" || mode === "managed-identity") return mode;
  throw new Error(`SQL_AUTH must be 'password' or 'managed-identity', not '${raw}'`);
}

// Unset means the driver's default, 1433.
export function sqlPort(env: Env): number | undefined {
  const raw = (env.SQL_PORT ?? "").trim();
  if (!raw) return undefined;
  const port = Number(raw);
  if (!/^[0-9]+$/.test(raw) || port < 1 || port > 65535) throw new Error(`SQL_PORT must be a port number from 1 to 65535, not '${env.SQL_PORT}'`);
  return port;
}

export function connectionConfig(env: Env = process.env): ConnectionConfiguration {
  const missing = (["SQL_SERVER", "SQL_DATABASE"] as const).filter((name) => !env[name]);
  if (missing.length) throw new Error(`${missing.join(" and ")} not set; refusing to guess which database to use`);
  const server = env.SQL_SERVER as string;
  const port = sqlPort(env);
  const options = {
    database: env.SQL_DATABASE as string,
    ...(port === undefined ? {} : { port }),
    encrypt: true,
    trustServerCertificate: false,
    connectTimeout: 30000,
    requestTimeout: 30000,
    rowCollectionOnRequestCompletion: true,
  };

  if (sqlAuth(env) === "managed-identity") {
    // Never AZURE_CLIENT_ID: here that is the Graph app registration, not an identity.
    const clientId = env.SQL_MANAGED_IDENTITY_CLIENT_ID;
    return {
      server,
      authentication: { type: "azure-active-directory-msi-app-service", options: clientId ? { clientId } : {} },
      options,
    };
  }

  const missingLogin = (["SQL_USER", "SQL_PASSWORD"] as const).filter((name) => !env[name]);
  if (missingLogin.length) throw new Error(`${missingLogin.join(" and ")} not set; refusing to connect without a SQL login`);
  return {
    server,
    authentication: { type: "default", options: { userName: env.SQL_USER as string, password: env.SQL_PASSWORD as string } },
    options,
  };
}

// Service-run and error records go to LOGGING_SQL_SERVER / LOGGING_SQL_DATABASE when both are set, for a
// pod whose own database has no logging schema, signing in the same way as the app. Neither set keeps them
// in the app's database; one alone throws rather than guess the other.
export function loggingEnv(env: Env = process.env): Env {
  const names = ["LOGGING_SQL_SERVER", "LOGGING_SQL_DATABASE"] as const;
  const missing = names.filter((name) => !env[name]);
  if (missing.length === names.length) return env;
  if (missing.length) throw new Error(`${missing[0]} not set; refusing to guess which database takes the logging records`);
  return { ...env, SQL_SERVER: env.LOGGING_SQL_SERVER, SQL_DATABASE: env.LOGGING_SQL_DATABASE, SQL_PORT: env.LOGGING_SQL_PORT };
}

function connect(env: Env): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const connection = new Connection(connectionConfig(env));
    connection.connect((error) => (error ? reject(error) : resolve(connection)));
  });
}

type Column = { metadata: { colName: string }; value: unknown };

async function run<T>(
  env: Env,
  text: string,
  params: QueryParam[],
  done: (rowCount: number, rows: Column[][]) => T,
): Promise<T> {
  const connection = await connect(env);
  return new Promise<T>((resolve, reject) => {
    try {
      const request = new Request(text, (error, rowCount, rows) => {
        connection.close();
        if (error) reject(error);
        else resolve(done(rowCount ?? 0, (rows ?? []) as Column[][]));
      });
      for (const param of params) request.addParameter(param.name, param.type, param.value);
      connection.execSql(request);
    } catch (error) {
      connection.close();
      reject(error);
    }
  });
}

export function query<T = Record<string, unknown>>(text: string, params: QueryParam[] = []): Promise<QueryResult<T>> {
  return run(process.env, text, params, (rowCount, rows) => ({
    rows: rows.map((columns) => {
      const row: Record<string, unknown> = {};
      for (const column of columns) row[column.metadata.colName] = column.value;
      return row as T;
    }),
    rowCount,
  }));
}

export function execute(text: string, params: QueryParam[] = []): Promise<number> {
  return run(process.env, text, params, (rowCount) => rowCount);
}

export async function executeLogging(text: string, params: QueryParam[] = []): Promise<number> {
  return run(loggingEnv(), text, params, (rowCount) => rowCount);
}
