import { query as fQuery, execute as fExecute, executeLogging as fExecuteLogging, TYPES } from "./db/connection";

type Primitive = string | number | boolean | Date | null | undefined;

function inferType(value: Primitive) {
  if (value === null || value === undefined) return TYPES.NVarChar;
  if (typeof value === "boolean") return TYPES.Bit;
  if (typeof value === "number") {
    return Number.isInteger(value) ? TYPES.Int : TYPES.Decimal;
  }
  if (value instanceof Date) return TYPES.DateTime2;
  return TYPES.NVarChar;
}

function toParams(params: Record<string, Primitive>) {
  return Object.entries(params).map(([name, value]) => ({
    name,
    type: inferType(value),
    value: value ?? null,
  }));
}

export async function query<T = unknown>(
  text: string,
  params: Record<string, Primitive> = {},
): Promise<T[]> {
  const result = await fQuery<T extends Record<string, unknown> ? T : Record<string, unknown>>(
    text,
    toParams(params),
  );
  return result.rows as T[];
}

export async function queryOne<T = unknown>(
  text: string,
  params: Record<string, Primitive> = {},
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function execute(
  text: string,
  params: Record<string, Primitive> = {},
): Promise<number> {
  return await fExecute(text, toParams(params));
}

export async function executeLogging(
  text: string,
  params: Record<string, Primitive> = {},
): Promise<number> {
  return await fExecuteLogging(text, toParams(params));
}
