import { createHash } from "node:crypto";

// The hash chain over a tenant's training records (migration 0034;
// docs/plans/2026-10-29-training-records-design.md §3.1). Each record's
// RowHash is SHA-256 over its PrevHash (the RowHash of the record before it,
// or 32 zero bytes for Seq 1) followed by the record's canonical bytes, so
// editing, removing or reordering any row breaks every hash after it. This
// file is the only place the recipe lives: the app computes the hash before
// the insert, and the verifier recomputes it from what the database returns.
//
// Canonical bytes: UTF-8 JSON of one object whose keys are always in
// CANONICAL_FIELDS order, behind a recipe version. Ids are lower-case, times
// are ISO 8601 UTC with milliseconds (DATETIME2(3) holds exactly that), and an
// absent value is an explicit null. Changing the order, a field or a format
// changes every hash; that needs a new CANONICAL_VERSION and a verifier that
// knows both.

export const CANONICAL_VERSION = 1;
export const GENESIS_HASH = "0".repeat(64);

export const RECORD_KINDS = [
  "course_completion",
  "exam_pass",
  "exam_fail",
  "exam_attempt_pending",
  "grade_change",
  // Entered by hand from R2.
  "check",
  "ojt",
  "line_indoc",
  "familiarization",
  "monitor",
  "qualification",
  "vendor_training",
  "acp_ppc",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export const RECORD_RESULTS = ["pass", "fail", "pending", "completed", "attended", "incomplete"] as const;
export type RecordResult = (typeof RECORD_RESULTS)[number];

export const RECORD_SOURCES = ["auto", "manual", "backfill"] as const;
export type RecordSource = (typeof RECORD_SOURCES)[number];

export interface RecordFields {
  recordId: string;
  tenantId: string;
  seq: number;
  learnerId: string;
  personName: string;
  personEmail: string;
  kind: RecordKind;
  occurredAt: Date;
  courseId: string | null;
  courseVersionId: string | null;
  courseTitle: string | null;
  quizId: string | null;
  attemptId: string | null;
  result: RecordResult;
  score: number | null;
  passingScore: number | null;
  failureDetail: string | null;
  source: RecordSource;
  recordedBy: string;
  recordedAt: Date;
  correctsRecordId: string | null;
  payloadJson: string | null;
}

export interface ChainedRecord extends RecordFields {
  prevHash: string;
  rowHash: string;
}

export const CANONICAL_FIELDS = [
  "recordId",
  "tenantId",
  "seq",
  "learnerId",
  "personName",
  "personEmail",
  "kind",
  "occurredAt",
  "courseId",
  "courseVersionId",
  "courseTitle",
  "quizId",
  "attemptId",
  "result",
  "score",
  "passingScore",
  "failureDetail",
  "source",
  "recordedBy",
  "recordedAt",
  "correctsRecordId",
  "payloadJson",
] as const satisfies readonly (keyof RecordFields)[];

const ID_FIELDS = new Set<string>(["recordId", "tenantId", "learnerId", "courseId", "courseVersionId", "quizId", "attemptId", "correctsRecordId"]);
const INT_FIELDS = new Set<string>(["seq", "score", "passingScore"]);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{64}$/;

function canonicalValue(name: string, value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error(`${name} is not a valid time`);
    return value.toISOString();
  }
  if (ID_FIELDS.has(name)) {
    const id = String(value).toLowerCase();
    if (!GUID.test(id)) throw new Error(`${name} is not a GUID`);
    return id;
  }
  if (INT_FIELDS.has(name)) {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${name} is not a whole number`);
    return value;
  }
  if (typeof value !== "string") throw new Error(`${name} is not text`);
  return value;
}

// The record's canonical JSON text, before UTF-8 encoding.
export function canonicalRecord(fields: RecordFields): string {
  const out: Record<string, string | number | null> = { v: CANONICAL_VERSION };
  for (const name of CANONICAL_FIELDS) out[name] = canonicalValue(name, fields[name]);
  return JSON.stringify(out);
}

function hexHash(name: string, hex: string): Buffer {
  const lower = hex.toLowerCase();
  if (!HEX32.test(lower)) throw new Error(`${name} is not a 32-byte hex hash`);
  return Buffer.from(lower, "hex");
}

// SHA-256(prevHash || canonical bytes), lower-case hex.
export function computeRowHash(prevHash: string, fields: RecordFields): string {
  return createHash("sha256")
    .update(hexHash("prevHash", prevHash))
    .update(Buffer.from(canonicalRecord(fields), "utf8"))
    .digest("hex");
}

export type ChainBreak = "gap" | "order" | "prev" | "hash" | "head";

export type ChainVerdict =
  | { ok: true; count: number; headSeq: number; headHash: string }
  | { ok: false; seq: number; reason: ChainBreak; detail: string };

export interface ChainHead {
  lastSeq: number;
  lastHash: string;
}

// Walks the rows in the order given (readChain returns them by Seq) and
// answers ok, or the first Seq at which the chain breaks and why:
//   gap   - a Seq is missing (a row was deleted)
//   order - a Seq is out of place (rows were reordered)
//   prev  - a row's PrevHash isn't the RowHash of the row before it
//   hash  - a row's fields no longer hash to its RowHash (it was edited)
//   head  - the rows end before, or differ from, the tenant's chain head
// With the head given, rows removed from the end are caught as well.
export function verifyChain(rows: readonly ChainedRecord[], head?: ChainHead | null): ChainVerdict {
  let prev = GENESIS_HASH;
  const seqs = new Set(rows.map((r) => r.seq));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const expected = i + 1;
    if (row.seq !== expected) {
      return seqs.has(expected)
        ? { ok: false, seq: expected, reason: "order", detail: `Seq ${expected} is out of place: Seq ${row.seq} is where it should be` }
        : { ok: false, seq: expected, reason: "gap", detail: `Seq ${expected} is missing: the next row is Seq ${row.seq}` };
    }
    if (row.prevHash.toLowerCase() !== prev) {
      return { ok: false, seq: row.seq, reason: "prev", detail: `Seq ${row.seq} doesn't follow the row before it: its PrevHash isn't that row's RowHash` };
    }
    let recomputed: string;
    try {
      recomputed = computeRowHash(prev, row);
    } catch (error) {
      return { ok: false, seq: row.seq, reason: "hash", detail: `Seq ${row.seq} can't be hashed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (recomputed !== row.rowHash.toLowerCase()) {
      return { ok: false, seq: row.seq, reason: "hash", detail: `Seq ${row.seq} was changed: its fields no longer hash to its RowHash` };
    }
    prev = recomputed;
  }
  const lastSeq = rows.length;
  if (head && head.lastSeq !== lastSeq) {
    return {
      ok: false,
      seq: Math.min(lastSeq, head.lastSeq) + 1,
      reason: "head",
      detail: `the chain head says Seq ${head.lastSeq}, the rows end at Seq ${lastSeq}`,
    };
  }
  if (head && head.lastHash.toLowerCase() !== prev) {
    return { ok: false, seq: lastSeq, reason: "head", detail: `Seq ${lastSeq} isn't the row the chain head names: its RowHash differs` };
  }
  return { ok: true, count: rows.length, headSeq: lastSeq, headHash: prev };
}
