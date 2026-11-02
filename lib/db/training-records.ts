import { randomUUID } from "node:crypto";
import { query, queryOne } from "@/lib/db";
import { isDeadlock } from "@/lib/db/deadlock";
import {
  computeRowHash,
  GENESIS_HASH,
  type ChainedRecord,
  type ChainHead,
  type RecordFields,
  type RecordKind,
  type RecordResult,
  type RecordSource,
} from "@/lib/records/chain";

// lms.TrainingRecord and its chain head (migration 0034;
// docs/plans/2026-10-29-training-records-design.md §3.1, slice R1a). Every
// statement here names the tenant. Nothing here updates or deletes a record:
// the table refuses both.
//
// An append reads the chain head, hashes the record onto it in the app
// (lib/records/chain.ts), then writes in one transaction that takes the head
// under UPDLOCK and inserts only if the head still names the Seq and hash it
// chained from. A writer that lost the race appends nothing, waits a random
// while, reads the head again and hashes afresh. DATETIME2(3) keeps whole
// milliseconds, as a JS Date does, so the times that are hashed are the times
// that come back.

// Writers that lose together and retry at once collide again, so only one
// lands per round. On SQL Server 2022 (scripts/prove-training-records.ts), 20
// parallel appends with 5 tries and no wait stored 7. A random wait that can
// double each time up to 1 s spreads a burst out: with it, 60 parallel appends
// all landed, none needing more than 16 tries.
export const APPEND_TRIES = 20;
export const APPEND_WAIT_MS = { first: 10, cap: 1000 };

export function appendWaitMs(retry: number, random: () => number = Math.random): number {
  return Math.floor(random() * Math.min(APPEND_WAIT_MS.cap, APPEND_WAIT_MS.first * 2 ** (retry - 1)));
}

export interface TrainingRecordInput {
  learnerId: string;
  kind: RecordKind;
  occurredAt: Date;
  result: RecordResult;
  source: RecordSource;
  recordedBy: string;
  courseId?: string | null;
  courseVersionId?: string | null;
  courseTitle?: string | null;
  quizId?: string | null;
  attemptId?: string | null;
  score?: number | null;
  passingScore?: number | null;
  failureDetail?: string | null;
  correctsRecordId?: string | null;
  payloadJson?: string | null;
}

type Outcome = "appended" | "changed" | "not_found";

const lower = (id: string | null) => (id === null ? null : id.toLowerCase());

const COLUMNS = `CONVERT(varchar(36), RecordId) AS RecordId, CONVERT(varchar(36), TenantId) AS TenantId, Seq,
            CONVERT(varchar(36), LearnerId) AS LearnerId, PersonName, PersonEmail, Kind, OccurredAt,
            CONVERT(varchar(36), CourseId) AS CourseId, CONVERT(varchar(36), CourseVersionId) AS CourseVersionId, CourseTitle,
            CONVERT(varchar(36), QuizId) AS QuizId, CONVERT(varchar(36), AttemptId) AS AttemptId, Result, Score, PassingScore,
            FailureDetail, Source, RecordedBy, RecordedAt, CONVERT(varchar(36), CorrectsRecordId) AS CorrectsRecordId,
            PayloadJson, CONVERT(varchar(64), PrevHash, 2) AS PrevHash, CONVERT(varchar(64), RowHash, 2) AS RowHash`;

interface RecordRow {
  RecordId: string;
  TenantId: string;
  // BIGINT reaches the app as a string.
  Seq: string | number;
  LearnerId: string;
  PersonName: string;
  PersonEmail: string;
  Kind: RecordKind;
  OccurredAt: Date;
  CourseId: string | null;
  CourseVersionId: string | null;
  CourseTitle: string | null;
  QuizId: string | null;
  AttemptId: string | null;
  Result: RecordResult;
  Score: number | null;
  PassingScore: number | null;
  FailureDetail: string | null;
  Source: RecordSource;
  RecordedBy: string;
  RecordedAt: Date;
  CorrectsRecordId: string | null;
  PayloadJson: string | null;
  PrevHash: string;
  RowHash: string;
}

function toRecord(row: RecordRow): ChainedRecord {
  return {
    recordId: lower(row.RecordId)!,
    tenantId: lower(row.TenantId)!,
    seq: Number(row.Seq),
    learnerId: lower(row.LearnerId)!,
    personName: row.PersonName,
    personEmail: row.PersonEmail,
    kind: row.Kind,
    occurredAt: new Date(row.OccurredAt),
    courseId: lower(row.CourseId),
    courseVersionId: lower(row.CourseVersionId),
    courseTitle: row.CourseTitle,
    quizId: lower(row.QuizId),
    attemptId: lower(row.AttemptId),
    result: row.Result,
    score: row.Score,
    passingScore: row.PassingScore,
    failureDetail: row.FailureDetail,
    source: row.Source,
    recordedBy: row.RecordedBy,
    recordedAt: new Date(row.RecordedAt),
    correctsRecordId: lower(row.CorrectsRecordId),
    payloadJson: row.PayloadJson,
    prevHash: row.PrevHash.toLowerCase(),
    rowHash: row.RowHash.toLowerCase(),
  };
}

async function readHead(tenantId: string): Promise<ChainHead | null> {
  const head = await queryOne<{ LastSeq: string | number; LastHash: string }>(
    `SELECT LastSeq, CONVERT(varchar(64), LastHash, 2) AS LastHash
       FROM lms.TrainingRecordChain
      WHERE TenantId = @tenantId`,
    { tenantId },
  );
  return head ? { lastSeq: Number(head.LastSeq), lastHash: head.LastHash.toLowerCase() } : null;
}

const APPEND = `SET XACT_ABORT ON;
     BEGIN TRANSACTION;
     DECLARE @outcome nvarchar(16) = N'not_found';
     DECLARE @lastSeq bigint, @lastHash varbinary(32);
     IF EXISTS (SELECT 1 FROM lms.Learner WHERE LearnerId = @learnerId AND TenantId = @tenantId)
        AND (@correctsRecordId IS NULL
             OR EXISTS (SELECT 1 FROM lms.TrainingRecord WHERE RecordId = @correctsRecordId AND TenantId = @tenantId))
     BEGIN
       SET @outcome = N'changed';
       IF NOT EXISTS (SELECT 1 FROM lms.TrainingRecordChain WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @tenantId)
         INSERT INTO lms.TrainingRecordChain (TenantId, LastSeq, LastHash) VALUES (@tenantId, 0, CONVERT(varbinary(32), @genesis, 2));
       SELECT @lastSeq = LastSeq, @lastHash = LastHash
         FROM lms.TrainingRecordChain WITH (UPDLOCK, HOLDLOCK)
        WHERE TenantId = @tenantId;
       IF @lastSeq = @expectedSeq AND @lastHash = CONVERT(varbinary(32), @prevHash, 2)
       BEGIN
         INSERT INTO lms.TrainingRecord (RecordId, TenantId, Seq, LearnerId, PersonName, PersonEmail, Kind, OccurredAt,
                                         CourseId, CourseVersionId, CourseTitle, QuizId, AttemptId, Result, Score, PassingScore,
                                         FailureDetail, Source, RecordedBy, RecordedAt, CorrectsRecordId, PayloadJson,
                                         PrevHash, RowHash)
         VALUES (@recordId, @tenantId, @seq, @learnerId, @personName, @personEmail, @kind, @occurredAt,
                 @courseId, @courseVersionId, @courseTitle, @quizId, @attemptId, @result, @score, @passingScore,
                 @failureDetail, @source, @recordedBy, @recordedAt, @correctsRecordId, @payloadJson,
                 CONVERT(varbinary(32), @prevHash, 2), CONVERT(varbinary(32), @rowHash, 2));
         UPDATE lms.TrainingRecordChain
            SET LastSeq = @seq, LastHash = CONVERT(varbinary(32), @rowHash, 2), UpdatedAt = SYSUTCDATETIME()
          WHERE TenantId = @tenantId;
         SET @outcome = N'appended';
       END
     END
     COMMIT TRANSACTION;
     SELECT @outcome AS Outcome;`;

// Appends one record to the tenant's chain and answers it as stored, or null
// when the learner (or the record it corrects) isn't the tenant's. The
// person's name and email are copied from lms.Learner as they stand now.
// Throws only on a database error or a chain too busy to join in
// APPEND_TRIES reads.
export async function appendTrainingRecord(
  tenantId: string,
  input: TrainingRecordInput,
  now: () => Date = () => new Date(),
): Promise<ChainedRecord | null> {
  const person = await queryOne<{ DisplayName: string; Email: string }>(
    `SELECT DisplayName, Email FROM lms.Learner WHERE LearnerId = @learnerId AND TenantId = @tenantId`,
    { tenantId, learnerId: input.learnerId },
  );
  if (!person) return null;

  const recordId = randomUUID();
  const recordedAt = now();
  for (let tries = 0; tries < APPEND_TRIES; tries++) {
    if (tries > 0) await new Promise((resolve) => setTimeout(resolve, appendWaitMs(tries)));
    const head = await readHead(tenantId);
    const expectedSeq = head?.lastSeq ?? 0;
    const prevHash = head?.lastHash ?? GENESIS_HASH;
    const fields: RecordFields = {
      recordId,
      tenantId: tenantId.toLowerCase(),
      seq: expectedSeq + 1,
      learnerId: input.learnerId.toLowerCase(),
      personName: person.DisplayName,
      personEmail: person.Email,
      kind: input.kind,
      occurredAt: input.occurredAt,
      courseId: lower(input.courseId ?? null),
      courseVersionId: lower(input.courseVersionId ?? null),
      courseTitle: input.courseTitle ?? null,
      quizId: lower(input.quizId ?? null),
      attemptId: lower(input.attemptId ?? null),
      result: input.result,
      score: input.score ?? null,
      passingScore: input.passingScore ?? null,
      failureDetail: input.failureDetail ?? null,
      source: input.source,
      recordedBy: input.recordedBy,
      recordedAt,
      correctsRecordId: lower(input.correctsRecordId ?? null),
      payloadJson: input.payloadJson ?? null,
    };
    const rowHash = computeRowHash(prevHash, fields);
    let outcome: Outcome;
    try {
      const row = await queryOne<{ Outcome: Outcome }>(APPEND, { ...fields, expectedSeq, prevHash, rowHash, genesis: GENESIS_HASH });
      outcome = row?.Outcome ?? "not_found";
    } catch (error) {
      // A deadlock victim's transaction changed nothing; it lost the race.
      if (!isDeadlock(error)) throw error;
      outcome = "changed";
    }
    if (outcome === "appended") return { ...fields, prevHash, rowHash };
    if (outcome === "not_found") return null;
  }
  throw new Error(`the training record chain stayed busy for ${APPEND_TRIES} tries`);
}

export interface TrainingRecordFilters {
  learnerId?: string;
  kind?: RecordKind;
  attemptId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export const LIST_LIMIT = 500;

// A tenant's records, newest first.
export async function listTrainingRecords(tenantId: string, filters: TrainingRecordFilters = {}): Promise<ChainedRecord[]> {
  const where = ["TenantId = @tenantId"];
  const params: Record<string, string | number | Date> = {
    tenantId,
    limit: Math.max(1, Math.min(LIST_LIMIT, Math.floor(filters.limit ?? LIST_LIMIT))),
  };
  if (filters.learnerId) {
    where.push("LearnerId = @learnerId");
    params.learnerId = filters.learnerId;
  }
  if (filters.kind) {
    where.push("Kind = @kind");
    params.kind = filters.kind;
  }
  if (filters.attemptId) {
    where.push("AttemptId = @attemptId");
    params.attemptId = filters.attemptId;
  }
  if (filters.from) {
    where.push("OccurredAt >= @from");
    params.from = filters.from;
  }
  if (filters.to) {
    where.push("OccurredAt < @to");
    params.to = filters.to;
  }
  const rows = await query<RecordRow>(
    `SELECT TOP (@limit) ${COLUMNS}
       FROM lms.TrainingRecord
      WHERE ${where.join(" AND ")}
      ORDER BY OccurredAt DESC, Seq DESC`,
    params,
  );
  return rows.map(toRecord);
}

// Every record of the tenant in Seq order, with the chain head, for the
// verifier (lib/records/chain.ts verifyChain).
export async function readChain(tenantId: string): Promise<{ rows: ChainedRecord[]; head: ChainHead | null }> {
  const rows = await query<RecordRow>(
    `SELECT ${COLUMNS}
       FROM lms.TrainingRecord
      WHERE TenantId = @tenantId
      ORDER BY Seq`,
    { tenantId },
  );
  return { rows: rows.map(toRecord), head: await readHead(tenantId) };
}

// ---- what slice R2a reads: one learner's records, one record, an import ----

// Every record of the tenant's learner in Seq order, corrections included.
export async function readLearnerRecords(tenantId: string, learnerId: string): Promise<ChainedRecord[]> {
  const rows = await query<RecordRow>(
    `SELECT ${COLUMNS}
       FROM lms.TrainingRecord
      WHERE TenantId = @tenantId AND LearnerId = @learnerId
      ORDER BY Seq`,
    { tenantId, learnerId },
  );
  return rows.map(toRecord);
}

export async function readTrainingRecord(tenantId: string, recordId: string): Promise<ChainedRecord | null> {
  const rows = await query<RecordRow>(
    `SELECT ${COLUMNS}
       FROM lms.TrainingRecord
      WHERE TenantId = @tenantId AND RecordId = @recordId
      ORDER BY Seq`,
    { tenantId, recordId },
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

// The tenant's records from one source in Seq order: the import reads its
// backfill rows to find what an earlier run of the same file wrote.
export async function readRecordsBySource(tenantId: string, source: RecordSource): Promise<ChainedRecord[]> {
  const rows = await query<RecordRow>(
    `SELECT ${COLUMNS}
       FROM lms.TrainingRecord
      WHERE TenantId = @tenantId AND Source = @source
      ORDER BY Seq`,
    { tenantId, source },
  );
  return rows.map(toRecord);
}

export interface TenantLearner {
  learnerId: string;
  email: string;
  displayName: string;
  status: string;
}

// Every learner of the tenant, whatever their status: a record can be
// entered or imported for someone who has left.
export async function listTenantLearners(tenantId: string): Promise<TenantLearner[]> {
  const rows = await query<{ LearnerId: string; Email: string; DisplayName: string; Status: string }>(
    `SELECT CONVERT(varchar(36), LearnerId) AS LearnerId, Email, DisplayName, Status
       FROM lms.Learner
      WHERE TenantId = @tenantId
      ORDER BY DisplayName`,
    { tenantId },
  );
  return rows.map((r) => ({ learnerId: r.LearnerId.toLowerCase(), email: r.Email, displayName: r.DisplayName, status: r.Status }));
}

// One learner of the tenant, whatever their status.
export async function readTenantLearner(tenantId: string, learnerId: string): Promise<TenantLearner | null> {
  const rows = await query<{ LearnerId: string; Email: string; DisplayName: string; Status: string }>(
    `SELECT CONVERT(varchar(36), LearnerId) AS LearnerId, Email, DisplayName, Status
       FROM lms.Learner
      WHERE TenantId = @tenantId AND LearnerId = @learnerId`,
    { tenantId, learnerId },
  );
  const r = rows[0];
  return r ? { learnerId: r.LearnerId.toLowerCase(), email: r.Email, displayName: r.DisplayName, status: r.Status } : null;
}

// A second correction of one record breaks UX_lms_TrainingRecord_Corrects
// (migration 0036): someone corrected it first.
export function isAlreadyCorrected(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UX_lms_TrainingRecord_Corrects");
}

// ---- what the automatic writers read about the event they record -----------

export interface CompletionContext {
  learnerEmail: string;
  courseId: string;
  versionId: string | null;
  courseTitle: string;
  completedAt: Date;
  cycleNo: number;
}

// The tenant's own learner's completed enrollment.
export async function readCompletionContext(tenantId: string, learnerId: string, courseId: string): Promise<CompletionContext | null> {
  const row = await queryOne<{ Email: string; CourseId: string; VersionId: string | null; Title: string; CompletedAt: Date; CycleNo: number }>(
    `SELECT l.Email, CONVERT(varchar(36), e.CourseId) AS CourseId, CONVERT(varchar(36), e.VersionId) AS VersionId,
            c.Title, e.CompletedAt, e.CycleNo
       FROM lms.Enrollment e
       JOIN lms.Learner l ON l.LearnerId = e.LearnerId
       JOIN lms.Course c ON c.CourseId = e.CourseId
      WHERE e.LearnerId = @learnerId AND e.CourseId = @courseId AND e.TenantId = @tenantId AND l.TenantId = @tenantId
        AND e.CompletedAt IS NOT NULL`,
    { tenantId, learnerId, courseId },
  );
  if (!row) return null;
  return {
    learnerEmail: row.Email,
    courseId: row.CourseId.toLowerCase(),
    versionId: lower(row.VersionId),
    courseTitle: row.Title,
    completedAt: new Date(row.CompletedAt),
    cycleNo: row.CycleNo,
  };
}

export interface AttemptContext {
  learnerId: string;
  learnerEmail: string;
  quizId: string;
  courseId: string;
  versionId: string | null;
  courseTitle: string;
  submittedAt: Date;
  isExam: boolean;
}

// An attempt of the tenant's own learner, with the course and version its
// quiz belongs to and whether that quiz is an exam (lms.Quiz.IsExam, 0035).
// lms.QuizAttempt has no TenantId, so the learner carries it.
export async function readAttemptContext(tenantId: string, attemptId: string): Promise<AttemptContext | null> {
  const row = await queryOne<{
    LearnerId: string; Email: string; QuizId: string; CourseId: string; VersionId: string | null; Title: string; SubmittedAt: Date | null;
    IsExam: boolean;
  }>(
    `SELECT CONVERT(varchar(36), a.LearnerId) AS LearnerId, l.Email, CONVERT(varchar(36), a.QuizId) AS QuizId,
            CONVERT(varchar(36), c.CourseId) AS CourseId, CONVERT(varchar(36), b.VersionId) AS VersionId,
            c.Title, a.SubmittedAt, q.IsExam
       FROM lms.QuizAttempt a
       JOIN lms.Learner l ON l.LearnerId = a.LearnerId
       JOIN lms.Quiz q ON q.QuizId = a.QuizId
       JOIN lms.Block b ON b.BlockId = q.BlockId
       JOIN lms.Lesson s ON s.LessonId = b.LessonId
       JOIN lms.Course c ON c.CourseId = s.CourseId
      WHERE a.AttemptId = @attemptId AND l.TenantId = @tenantId`,
    { tenantId, attemptId },
  );
  if (!row || !row.SubmittedAt) return null;
  return {
    learnerId: row.LearnerId.toLowerCase(),
    learnerEmail: row.Email,
    quizId: row.QuizId.toLowerCase(),
    courseId: row.CourseId.toLowerCase(),
    versionId: lower(row.VersionId),
    courseTitle: row.Title,
    submittedAt: new Date(row.SubmittedAt),
    isExam: row.IsExam === true,
  };
}
