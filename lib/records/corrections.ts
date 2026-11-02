import { z } from "zod";
import {
  appendTrainingRecord,
  isAlreadyCorrected,
  readLearnerRecords,
  readTrainingRecord,
  type TrainingRecordInput,
} from "@/lib/db/training-records";
import type { ChainedRecord } from "./chain";
import { checkEntry, DETAIL_KEYS, entryRecordInput, EntryFields, isManualKind, parseOccurredOn, type EntryIssue } from "./manual";

// Correcting a training record (docs/plans/2026-10-29-training-records-design.md
// §3.1, slice R2a). A correction never edits a row: it is a new record that
// names the one it corrects (CorrectsRecordId), with the admin's reason in
// its payload and the admin as RecordedBy, so the original, the reason and
// who made the change all stay. Migration 0036 holds a correction to the
// same tenant and learner and lets a record be corrected only once, so a
// record's corrections are one line and its newest row is the one in force.
// Only that newest row can be corrected.
//
// A manual or imported record can be corrected in any field. An automatic
// record (a completion or an exam) changes its result only through marking,
// so here only its date and title can change. Voiding keeps every field and
// marks the record void, for one entered against the wrong person or twice.

export const CorrectionBody = z
  .object({
    reason: z.string().trim().min(1, "Give the reason for the correction.").max(1000),
    void: z.literal(true).optional(),
    changes: EntryFields.partial().strict().optional(),
  })
  .strict();

export type CorrectionInput = z.output<typeof CorrectionBody>;

const RESERVED_KEYS = new Set(["correctionReason", "void", "importId", "importRow"]);
const AUTO_CHANGEABLE = new Set(["occurredOn", "title"]);

export type RecordDetails = Record<string, unknown>;

export function recordDetails(record: Pick<ChainedRecord, "payloadJson">): RecordDetails {
  if (!record.payloadJson) return {};
  try {
    const value: unknown = JSON.parse(record.payloadJson);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordDetails) : {};
  } catch {
    return {};
  }
}

export const isVoid = (record: Pick<ChainedRecord, "payloadJson">) => recordDetails(record).void === true;

// The details a correction carries forward: the original's, without the
// reason, void flag or import position that belonged to the original row.
function carriedDetails(record: ChainedRecord): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(recordDetails(record))) {
    if (RESERVED_KEYS.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
}

export type CorrectionBuild = { ok: true; input: TrainingRecordInput } | { ok: false; issues: EntryIssue[] };

// The record that corrects `target` as `body` asks, or why it can't.
export function buildCorrection(target: ChainedRecord, body: CorrectionInput, recordedBy: string, now: Date = new Date()): CorrectionBuild {
  if (body.void && body.changes) return { ok: false, issues: [{ field: "void", message: "Void the record or change it, not both." }] };
  if (!body.void && (!body.changes || Object.keys(body.changes).length === 0)) {
    return { ok: false, issues: [{ field: "changes", message: "Say what to change, or void the record." }] };
  }
  const base: TrainingRecordInput = {
    learnerId: target.learnerId,
    kind: target.kind,
    occurredAt: target.occurredAt,
    result: target.result,
    source: "manual",
    recordedBy,
    courseId: target.courseId,
    courseVersionId: target.courseVersionId,
    courseTitle: target.courseTitle,
    quizId: target.quizId,
    attemptId: target.attemptId,
    score: target.score,
    passingScore: target.passingScore,
    failureDetail: target.failureDetail,
    correctsRecordId: target.recordId,
  };
  const reason = { correctionReason: body.reason };

  if (body.void) {
    return { ok: true, input: { ...base, payloadJson: JSON.stringify({ ...carriedDetails(target), ...reason, void: true }) } };
  }
  const changes = body.changes!;

  if (!isManualKind(target.kind)) {
    const refused = Object.keys(changes).filter((key) => !AUTO_CHANGEABLE.has(key));
    if (refused.length > 0) {
      return {
        ok: false,
        issues: refused.map((field) => ({ field, message: "An automatic record's result changes only through marking: only its date and title can be corrected here." })),
      };
    }
    let occurredAt = target.occurredAt;
    if (changes.occurredOn !== undefined) {
      const at = parseOccurredOn(changes.occurredOn.trim(), now);
      if (typeof at === "string") return { ok: false, issues: [{ field: "occurredOn", message: at }] };
      occurredAt = at;
    }
    return {
      ok: true,
      input: {
        ...base,
        occurredAt,
        courseTitle: changes.title !== undefined ? changes.title.trim() : target.courseTitle,
        payloadJson: JSON.stringify({ ...carriedDetails(target), ...reason }),
      },
    };
  }

  const carried = carriedDetails(target);
  const details = Object.fromEntries(DETAIL_KEYS.filter((k) => carried[k] !== undefined).map((k) => [k, carried[k]]));
  const merged = {
    kind: target.kind,
    title: target.courseTitle ?? "",
    occurredOn: target.occurredAt.toISOString(),
    result: target.result,
    score: target.score ?? undefined,
    passingScore: target.passingScore ?? undefined,
    failureDetail: target.failureDetail ?? undefined,
    ...details,
    ...changes,
  };
  const checked = checkEntry(merged, now);
  if (!checked.ok) return checked;
  const others = Object.fromEntries(Object.entries(carried).filter(([k]) => !(DETAIL_KEYS as readonly string[]).includes(k)));
  const input = entryRecordInput(target.learnerId, checked.entry, "manual", recordedBy, { ...others, ...reason });
  return { ok: true, input: { ...input, correctsRecordId: target.recordId } };
}

// The newest row of each record's line of corrections, newest event first.
// A voided record is left out.
export function currentRecords(records: readonly ChainedRecord[]): ChainedRecord[] {
  const corrected = new Set(records.map((r) => r.correctsRecordId).filter((id): id is string => id !== null));
  return records
    .filter((r) => !corrected.has(r.recordId) && !isVoid(r))
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.seq - a.seq);
}

// The whole line of corrections `recordId` belongs to, oldest first: the
// first record entered, each correction of it, and the one in force last.
export function correctionLine(records: readonly ChainedRecord[], recordId: string): ChainedRecord[] {
  const byId = new Map(records.map((r) => [r.recordId, r]));
  const correctedBy = new Map(records.filter((r) => r.correctsRecordId).map((r) => [r.correctsRecordId!, r]));
  let first = byId.get(recordId.toLowerCase());
  if (!first) return [];
  const seen = new Set<string>();
  while (first.correctsRecordId && byId.has(first.correctsRecordId) && !seen.has(first.recordId)) {
    seen.add(first.recordId);
    first = byId.get(first.correctsRecordId)!;
  }
  const line: ChainedRecord[] = [first];
  for (let next = correctedBy.get(first.recordId); next && line.length <= records.length; next = correctedBy.get(next.recordId)) line.push(next);
  return line;
}

export type CorrectionOutcome =
  | { outcome: "corrected"; record: ChainedRecord }
  | { outcome: "not_found" }
  | { outcome: "already_corrected"; currentRecordId: string }
  | { outcome: "invalid"; issues: EntryIssue[] };

export async function correctRecord(
  tenantId: string,
  recordId: string,
  body: CorrectionInput,
  recordedBy: string,
  now: Date = new Date(),
): Promise<CorrectionOutcome> {
  const target = await readTrainingRecord(tenantId, recordId);
  if (!target) return { outcome: "not_found" };
  const alreadyCorrected = (records: readonly ChainedRecord[]): CorrectionOutcome => {
    const line = correctionLine(records, target.recordId);
    return { outcome: "already_corrected", currentRecordId: line[line.length - 1]?.recordId ?? target.recordId };
  };
  const records = await readLearnerRecords(tenantId, target.learnerId);
  if (records.some((r) => r.correctsRecordId === target.recordId)) return alreadyCorrected(records);

  const built = buildCorrection(target, body, recordedBy, now);
  if (!built.ok) return { outcome: "invalid", issues: built.issues };
  try {
    const record = await appendTrainingRecord(tenantId, built.input);
    return record ? { outcome: "corrected", record } : { outcome: "not_found" };
  } catch (error) {
    if (isAlreadyCorrected(error)) return alreadyCorrected(await readLearnerRecords(tenantId, target.learnerId));
    throw error;
  }
}

export interface RecordView {
  recordId: string;
  seq: number;
  learnerId: string;
  personName: string;
  kind: string;
  title: string | null;
  occurredAt: string;
  result: string;
  score: number | null;
  passingScore: number | null;
  failureDetail: string | null;
  source: string;
  recordedBy: string;
  recordedAt: string;
  correctsRecordId: string | null;
  details: RecordDetails;
  void: boolean;
  rowHash: string;
}

// A record as the admin routes answer it.
export function recordView(record: ChainedRecord): RecordView {
  return {
    recordId: record.recordId,
    seq: record.seq,
    learnerId: record.learnerId,
    personName: record.personName,
    kind: record.kind,
    title: record.courseTitle,
    occurredAt: record.occurredAt.toISOString(),
    result: record.result,
    score: record.score,
    passingScore: record.passingScore,
    failureDetail: record.failureDetail,
    source: record.source,
    recordedBy: record.recordedBy,
    recordedAt: record.recordedAt.toISOString(),
    correctsRecordId: record.correctsRecordId,
    details: recordDetails(record),
    void: isVoid(record),
    rowHash: record.rowHash,
  };
}
