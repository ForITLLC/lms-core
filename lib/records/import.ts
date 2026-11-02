import { createHash } from "node:crypto";
import {
  appendTrainingRecord,
  listTenantLearners,
  readRecordsBySource,
  type TenantLearner,
} from "@/lib/db/training-records";
import { recordDetails } from "./corrections";
import { CsvError, parseCsv } from "./csv";
import { checkEntry, entryRecordInput, type ManualEntry } from "./manual";

// Importing paper and spreadsheet training records from CSV (docs/plans/2026-10-29-training-records-design.md
// §3.2, slice R2a). Every row is checked by the rules a hand-entered record
// meets (./manual.ts) and matched to a learner of the admin's own tenant by
// email. A dry run checks the whole file and writes nothing. A real import
// writes only a file with no bad row, each row as a 'backfill' record, so an
// inspector can tell migrated records from native ones. Rows are appended one
// by one through the one append path, each carrying the file's SHA-256
// (importId) and its row number; if an import stops part way, running the
// same file again writes only the rows still missing.

export const MAX_IMPORT_BYTES = 1_000_000;
export const MAX_IMPORT_ROWS = 2000;

// CSV column -> entry field. "email" picks the learner.
export const IMPORT_COLUMNS = {
  email: "email",
  kind: "kind",
  title: "title",
  occurred_on: "occurredOn",
  result: "result",
  score: "score",
  passing_score: "passingScore",
  failure_detail: "failureDetail",
  instructor: "instructorName",
  assessor: "assessorName",
  evidence_ref: "evidenceRef",
  external_ref: "externalRef",
  check_type: "checkType",
  aircraft_type: "aircraftType",
} as const;
type Column = keyof typeof IMPORT_COLUMNS;
const REQUIRED_COLUMNS: readonly Column[] = ["email", "kind", "title", "occurred_on", "result", "evidence_ref"];
const FIELD_COLUMN: Record<string, Column> = Object.fromEntries(Object.entries(IMPORT_COLUMNS).map(([c, f]) => [f, c as Column]));

export interface ImportIssue {
  // The row's number in the file, counting the header as row 1.
  row: number;
  column: string;
  message: string;
}

export interface PlannedRow {
  row: number;
  learnerId: string;
  entry: ManualEntry;
}

export type ImportPlan =
  | { ok: false; error: string }
  | { ok: true; importId: string; rows: number; valid: PlannedRow[]; issues: ImportIssue[] };

const normalizeHeader = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, "_");
const WHOLE = /^\s*\d+\s*$/;

export function importIdOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Reads and checks the file against the tenant's learners. Writes nothing.
export function planImport(text: string, learners: readonly TenantLearner[], now: Date = new Date()): ImportPlan {
  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES) return { ok: false, error: `The file is over ${MAX_IMPORT_BYTES / 1_000_000} MB.` };
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (error) {
    if (error instanceof CsvError) return { ok: false, error: `The file isn't valid CSV: ${error.message}.` };
    throw error;
  }
  const header = table[0]?.map(normalizeHeader);
  if (!header || header.every((h) => h === "")) return { ok: false, error: "The file is empty." };
  const known = Object.keys(IMPORT_COLUMNS);
  const unknown = header.filter((h) => !known.includes(h));
  if (unknown.length > 0) return { ok: false, error: `Unknown column ${unknown.map((u) => `"${u}"`).join(", ")}. The columns are: ${known.join(", ")}.` };
  const repeated = header.filter((h, i) => header.indexOf(h) !== i);
  if (repeated.length > 0) return { ok: false, error: `Column "${repeated[0]}" appears twice.` };
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) return { ok: false, error: `Missing column ${missing.map((m) => `"${m}"`).join(", ")}.` };
  if (!header.includes("instructor") && !header.includes("assessor")) return { ok: false, error: "Add an instructor or an assessor column." };

  const body = table.slice(1).map((cells, i) => ({ row: i + 2, cells })).filter((r) => r.cells.some((c) => c.trim() !== ""));
  if (body.length === 0) return { ok: false, error: "The file has a header but no rows." };
  if (body.length > MAX_IMPORT_ROWS) return { ok: false, error: `The file has ${body.length} rows; import at most ${MAX_IMPORT_ROWS} at a time.` };

  const byEmail = new Map(learners.map((l) => [l.email.trim().toLowerCase(), l]));
  const valid: PlannedRow[] = [];
  const issues: ImportIssue[] = [];
  for (const { row, cells } of body) {
    if (cells.length !== header.length) {
      issues.push({ row, column: "", message: `The row has ${cells.length} cells; the header has ${header.length}.` });
      continue;
    }
    const fields: Record<string, unknown> = {};
    let email = "";
    let rowIssues = 0;
    header.forEach((column, i) => {
      const value = cells[i]!;
      if (column === "email") email = value.trim().toLowerCase();
      else if (column === "score" || column === "passing_score") {
        if (value.trim() === "") return;
        if (!WHOLE.test(value)) {
          issues.push({ row, column, message: "Give a whole number from 0 to 100." });
          rowIssues++;
          return;
        }
        fields[IMPORT_COLUMNS[column]] = Number(value);
      } else fields[IMPORT_COLUMNS[column as Column]] = value;
    });
    const learner = byEmail.get(email);
    if (!learner) {
      issues.push({ row, column: "email", message: email ? "No learner in your organisation has this email." : "Give the learner's email." });
      rowIssues++;
    }
    const checked = checkEntry(fields, now);
    if (!checked.ok) {
      for (const issue of checked.issues) issues.push({ row, column: FIELD_COLUMN[issue.field] ?? issue.field, message: issue.message });
      continue;
    }
    if (rowIssues === 0) valid.push({ row, learnerId: learner!.learnerId, entry: checked.entry });
  }
  return { ok: true, importId: importIdOf(text), rows: body.length, valid, issues };
}

export type ImportOutcome =
  | { outcome: "refused"; error: string }
  | { outcome: "dry_run"; importId: string; rows: number; wouldWrite: number; alreadyWritten: number; issues: ImportIssue[] }
  | { outcome: "invalid"; importId: string; rows: number; issues: ImportIssue[] }
  | { outcome: "imported"; importId: string; rows: number; written: number; alreadyWritten: number }
  | { outcome: "stopped"; importId: string; rows: number; written: number; stoppedAtRow: number; error: unknown };

export async function runImport(
  tenantId: string,
  text: string,
  options: { dryRun: boolean; recordedBy: string; now?: Date },
): Promise<ImportOutcome> {
  const plan = planImport(text, await listTenantLearners(tenantId), options.now);
  if (!plan.ok) return { outcome: "refused", error: plan.error };

  const written = new Set<number>();
  for (const record of await readRecordsBySource(tenantId, "backfill")) {
    const details = recordDetails(record);
    if (details.importId === plan.importId && typeof details.importRow === "number") written.add(details.importRow);
  }
  const todo = plan.valid.filter((r) => !written.has(r.row));
  if (options.dryRun) {
    return { outcome: "dry_run", importId: plan.importId, rows: plan.rows, wouldWrite: todo.length, alreadyWritten: plan.valid.length - todo.length, issues: plan.issues };
  }
  if (plan.issues.length > 0) return { outcome: "invalid", importId: plan.importId, rows: plan.rows, issues: plan.issues };

  let count = 0;
  for (const planned of todo) {
    try {
      const record = await appendTrainingRecord(
        tenantId,
        entryRecordInput(planned.learnerId, planned.entry, "backfill", options.recordedBy, { importId: plan.importId, importRow: planned.row }),
      );
      if (!record) throw new Error(`learner ${planned.learnerId} is no longer the tenant's`);
      count++;
    } catch (error) {
      return { outcome: "stopped", importId: plan.importId, rows: plan.rows, written: count, stoppedAtRow: planned.row, error };
    }
  }
  return { outcome: "imported", importId: plan.importId, rows: plan.rows, written: count, alreadyWritten: plan.valid.length - todo.length };
}
