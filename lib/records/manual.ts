import { z } from "zod";
import { appendTrainingRecord, type TrainingRecordInput } from "@/lib/db/training-records";
import type { ChainedRecord, RecordSource } from "./chain";

// Training records an admin enters by hand (docs/plans/2026-10-29-training-records-design.md
// §3.2, slice R2a): checks, OJT, line indoctrination, familiarization,
// monitors, qualifications, vendor training and ACP PPC references. Each one
// names its instructor or assessor and its evidence. The evidence is a
// reference written as text (a paper file, a vendor certificate number, a
// PFTR number): files are not uploaded until uploads are scanned for
// malware. A record goes through the one append path
// (lib/db/training-records.ts), so it joins the tenant's hash chain like an
// automatic one. The same rules check an imported row (./import.ts) and the
// changes a correction makes (./corrections.ts).

export const MANUAL_KINDS = ["check", "ojt", "line_indoc", "familiarization", "monitor", "qualification", "vendor_training", "acp_ppc"] as const;
export type ManualKind = (typeof MANUAL_KINDS)[number];
export const MANUAL_RESULTS = ["pass", "fail", "completed", "attended", "incomplete"] as const;
export const CHECK_TYPES = ["ppc", "competency_check", "line_check", "monitor", "other"] as const;

export const isManualKind = (kind: string): kind is ManualKind => (MANUAL_KINDS as readonly string[]).includes(kind);

// The details a record keeps in PayloadJson, in the order they are written,
// so the same entry always hashes the same.
export const DETAIL_KEYS = ["instructorName", "assessorName", "evidenceRef", "externalRef", "checkType", "aircraftType"] as const;

const EARLIEST = Date.UTC(1950, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const score = z.preprocess(blankToUndefined, z.number().int().min(0).max(100).optional());

export const EntryFields = z
  .object({
    kind: z.enum(MANUAL_KINDS),
    title: z.string().trim().min(1, "Give the record a title.").max(256),
    occurredOn: z.string().trim(),
    result: z.enum(MANUAL_RESULTS),
    score,
    passingScore: score,
    failureDetail: optionalText(1000),
    instructorName: optionalText(256),
    assessorName: optionalText(256),
    evidenceRef: z.string().trim().min(1, "Give the evidence reference: a paper file, certificate or PFTR number.").max(256),
    externalRef: optionalText(256),
    checkType: z.preprocess(blankToUndefined, z.enum(CHECK_TYPES).optional()),
    aircraftType: optionalText(64),
  })
  .strict();

export type EntryInput = z.input<typeof EntryFields>;

export interface ManualEntry extends Omit<z.output<typeof EntryFields>, "occurredOn"> {
  occurredAt: Date;
}

export interface EntryIssue {
  field: string;
  message: string;
}

export type EntryCheck = { ok: true; entry: ManualEntry } | { ok: false; issues: EntryIssue[] };

// A date (taken as midnight UTC) or a time with its offset. Not before 1950,
// and not more than a day ahead, which covers every time zone's today.
export function parseOccurredOn(value: string, now: Date): Date | string {
  if (!DATE_ONLY.test(value) && !DATE_TIME.test(value)) return "Give the date as YYYY-MM-DD.";
  const at = new Date(DATE_ONLY.test(value) ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(at.getTime())) return "That date doesn't exist.";
  if (DATE_ONLY.test(value) && at.toISOString().slice(0, 10) !== value) return "That date doesn't exist.";
  if (at.getTime() < EARLIEST) return "The date is before 1950.";
  if (at.getTime() > now.getTime() + DAY_MS) return "The date is in the future.";
  return at;
}

export function checkEntry(input: unknown, now: Date = new Date()): EntryCheck {
  const parsed = EntryFields.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ field: i.path.join(".") || "entry", message: i.message })) };
  }
  const { occurredOn, ...e } = parsed.data;
  const issues: EntryIssue[] = [];
  const occurredAt = parseOccurredOn(occurredOn, now);
  if (typeof occurredAt === "string") issues.push({ field: "occurredOn", message: occurredAt });
  if (e.result === "fail" && !e.failureDetail) issues.push({ field: "failureDetail", message: "A fail needs what was failed and why." });
  if (!e.instructorName && !e.assessorName) issues.push({ field: "instructorName", message: "Name the instructor or the assessor." });
  if (e.checkType && e.kind !== "check") issues.push({ field: "checkType", message: "A check type goes only on a check." });
  if (e.score !== undefined && e.passingScore !== undefined) {
    if (e.result === "pass" && e.score < e.passingScore) issues.push({ field: "score", message: "A pass can't score below the pass mark." });
    if (e.result === "fail" && e.score >= e.passingScore) issues.push({ field: "score", message: "A fail must score below the pass mark." });
  }
  if (issues.length > 0 || typeof occurredAt === "string") return { ok: false, issues };
  return { ok: true, entry: { ...e, occurredAt } };
}

export type PayloadExtra = Record<string, string | number | boolean>;

// The record's details, then whatever the caller adds (an import's file and
// row, a correction's reason), as JSON with its keys in a fixed order.
export function entryPayload(entry: Partial<Pick<ManualEntry, (typeof DETAIL_KEYS)[number]>>, extra: PayloadExtra = {}): string {
  const out: Record<string, string | number | boolean> = {};
  for (const key of DETAIL_KEYS) {
    const value = entry[key];
    if (value !== undefined) out[key] = value;
  }
  return JSON.stringify({ ...out, ...extra });
}

export function entryRecordInput(
  learnerId: string,
  entry: ManualEntry,
  source: Extract<RecordSource, "manual" | "backfill">,
  recordedBy: string,
  extra: PayloadExtra = {},
): TrainingRecordInput {
  return {
    learnerId,
    kind: entry.kind,
    occurredAt: entry.occurredAt,
    result: entry.result,
    source,
    recordedBy,
    courseTitle: entry.title,
    score: entry.score ?? null,
    passingScore: entry.passingScore ?? null,
    failureDetail: entry.failureDetail ?? null,
    payloadJson: entryPayload(entry, extra),
  };
}

// Appends the entry for the tenant's learner, recorded as the admin who
// entered it. Null when the learner isn't the tenant's.
export async function recordManualEntry(tenantId: string, learnerId: string, entry: ManualEntry, recordedBy: string): Promise<ChainedRecord | null> {
  return appendTrainingRecord(tenantId, entryRecordInput(learnerId, entry, "manual", recordedBy));
}
