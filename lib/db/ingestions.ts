import { randomUUID } from "node:crypto";
import { execute, query, queryOne } from "@/lib/db";
import { readUsage, type Usage } from "@/lib/ai/authoring/usage";

// lms.AssetIngestion as the AI authoring job queue
// (docs/plans/2026-10-29-ai-authoring.md, slice A2). A worker claims a job
// under a lease token; every write after that names the job's tenant and its
// token, so a worker whose lease ran out and was taken by another can't write.

export type IngestionStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type IngestionStage = "extract" | "outline" | "lessons" | "saving";

// Long enough for the slowest single step (one lesson's model calls); every
// stage write renews it.
export const LEASE_SECONDS = 600;

export interface ClaimedIngestion {
  ingestionId: string;
  tenantId: string;
  createdBy: string | null;
  sourceKind: string;
  sourceRef: string;
  stage: IngestionStage | null;
  attempts: number;
  leaseToken: string;
  optionsJson: string | null;
  workJson: string | null;
  usageJson: string | null;
  resultCourseId: string | null;
}

export interface IngestionWarning {
  lesson: number;
  position: number;
  kind: string;
  reason: string;
}

export interface IngestionRecord {
  ingestionId: string;
  status: IngestionStatus;
  stage: IngestionStage | null;
  lessonsDone: number;
  lessonsTotal: number | null;
  attempts: number;
  sourceKind: string;
  sourceRef: string;
  warnings: IngestionWarning[];
  usage: Usage;
  courseId: string | null;
  error: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  notBefore: Date;
  leaseUntil: Date | null;
}

interface ClaimRow {
  IngestionId: string;
  TenantId: string;
  CreatedBy: string | null;
  SourceKind: string;
  SourceRef: string;
  Stage: IngestionStage | null;
  Attempts: number;
  OptionsJson: string | null;
  WorkJson: string | null;
  UsageJson: string | null;
  ResultCourseId: string | null;
}

interface RecordRow {
  IngestionId: string;
  Status: IngestionStatus;
  Stage: IngestionStage | null;
  LessonsDone: number;
  LessonsTotal: number | null;
  Attempts: number;
  SourceKind: string;
  SourceRef: string;
  WarningsJson: string | null;
  UsageJson: string | null;
  ResultCourseId: string | null;
  ErrorMessage: string | null;
  CreatedBy: string | null;
  CreatedAt: Date;
  UpdatedAt: Date;
  NotBefore: Date;
  LeaseUntil?: Date | null;
}

const CLAIM_SET = `SET Status = 'running', Attempts = Attempts + 1, LeaseToken = @leaseToken,
       LeaseUntil = DATEADD(second, @leaseSeconds, SYSUTCDATETIME()), UpdatedAt = SYSUTCDATETIME()
OUTPUT CONVERT(varchar(36), inserted.IngestionId) AS IngestionId, CONVERT(varchar(36), inserted.TenantId) AS TenantId,
       inserted.CreatedBy, inserted.SourceKind, inserted.SourceRef, inserted.Stage, inserted.Attempts,
       inserted.OptionsJson, inserted.WorkJson, inserted.UsageJson, CONVERT(varchar(36), inserted.ResultCourseId) AS ResultCourseId`;

const CLAIMABLE = `((Status = 'queued' AND NotBefore <= SYSUTCDATETIME())
          OR (Status = 'running' AND LeaseUntil < SYSUTCDATETIME()))`;

// Every write a worker makes after its claim: its own job, in its tenant,
// still running under its token.
const HELD = `IngestionId = @ingestionId AND TenantId = @tenantId AND LeaseToken = @leaseToken AND Status = 'running'`;

const RECORD_COLUMNS = `CONVERT(varchar(36), IngestionId) AS IngestionId, Status, Stage, LessonsDone, LessonsTotal, Attempts,
       SourceKind, SourceRef, WarningsJson, UsageJson, CONVERT(varchar(36), ResultCourseId) AS ResultCourseId, ErrorMessage,
       CreatedBy, CreatedAt, UpdatedAt, NotBefore, LeaseUntil`;

function toClaimed(row: ClaimRow | null, leaseToken: string): ClaimedIngestion | null {
  if (!row) return null;
  return {
    ingestionId: row.IngestionId.toLowerCase(),
    tenantId: row.TenantId.toLowerCase(),
    createdBy: row.CreatedBy,
    sourceKind: row.SourceKind,
    sourceRef: row.SourceRef,
    stage: row.Stage,
    attempts: row.Attempts,
    leaseToken,
    optionsJson: row.OptionsJson,
    workJson: row.WorkJson,
    usageJson: row.UsageJson,
    resultCourseId: row.ResultCourseId?.toLowerCase() ?? null,
  };
}

function toRecord(row: RecordRow): IngestionRecord {
  return {
    ingestionId: row.IngestionId.toLowerCase(),
    status: row.Status,
    stage: row.Stage,
    lessonsDone: row.LessonsDone,
    lessonsTotal: row.LessonsTotal,
    attempts: row.Attempts,
    sourceKind: row.SourceKind,
    sourceRef: row.SourceRef,
    warnings: readWarnings(row.WarningsJson),
    usage: readUsage(row.UsageJson),
    courseId: row.ResultCourseId?.toLowerCase() ?? null,
    error: row.ErrorMessage,
    createdBy: row.CreatedBy,
    createdAt: row.CreatedAt,
    updatedAt: row.UpdatedAt,
    notBefore: row.NotBefore,
    leaseUntil: row.LeaseUntil ?? null,
  };
}

function readWarnings(json: string | null): IngestionWarning[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as IngestionWarning[]) : [];
  } catch {
    return [];
  }
}

export async function enqueueIngestion(
  tenantId: string,
  input: { createdBy: string; sourceKind: string; sourceRef: string; options: Record<string, unknown> },
): Promise<string> {
  const ingestionId = randomUUID();
  await execute(
    `INSERT INTO lms.AssetIngestion (IngestionId, TenantId, SourceKind, SourceRef, Status, CreatedBy, OptionsJson)
     VALUES (@ingestionId, @tenantId, @sourceKind, @sourceRef, 'queued', @createdBy, @options)`,
    {
      ingestionId,
      tenantId,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      createdBy: input.createdBy,
      options: JSON.stringify(input.options),
    },
  );
  return ingestionId;
}

export interface EnqueueLimits {
  maxActive: number;
  maxPerMonth: number;
}

export type LimitedEnqueue =
  | { queued: true; ingestionId: string }
  | { queued: false; reached: "active" | "monthly"; active: number; thisMonth: number };

// An author's job, queued only while the tenant is under both caps: jobs
// queued or running, and jobs started this calendar month (UTC) whatever
// became of them. The count and the insert are one transaction, and it takes
// the tenant row's update lock first, so a second enqueue for the same tenant
// waits for the first to commit and then counts its job: two requests can't
// both pass a count one below the cap. Nothing else takes that lock, so other
// tenants and the worker's writes never wait on it.
export async function enqueueIngestionWithinLimits(
  tenantId: string,
  input: { createdBy: string; sourceKind: string; sourceRef: string; options: Record<string, unknown> },
  limits: EnqueueLimits,
): Promise<LimitedEnqueue> {
  const ingestionId = randomUUID();
  const row = await queryOne<{ Queued: boolean | number; Active: number; ThisMonth: number }>(
    `SET XACT_ABORT ON;
     BEGIN TRANSACTION;
     DECLARE @held bit, @active int, @thisMonth int;
     SELECT @held = 1 FROM lms.Tenant WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @tenantId;
     SELECT @active = COUNT(CASE WHEN Status IN ('queued', 'running') THEN 1 END),
            @thisMonth = COUNT(CASE WHEN CreatedAt >= DATEFROMPARTS(YEAR(SYSUTCDATETIME()), MONTH(SYSUTCDATETIME()), 1) THEN 1 END)
       FROM lms.AssetIngestion
      WHERE TenantId = @tenantId;
     IF @active < @maxActive AND @thisMonth < @maxPerMonth
       INSERT INTO lms.AssetIngestion (IngestionId, TenantId, SourceKind, SourceRef, Status, CreatedBy, OptionsJson)
       VALUES (@ingestionId, @tenantId, @sourceKind, @sourceRef, 'queued', @createdBy, @options);
     COMMIT TRANSACTION;
     SELECT CAST(CASE WHEN @active < @maxActive AND @thisMonth < @maxPerMonth THEN 1 ELSE 0 END AS bit) AS Queued,
            @active AS Active, @thisMonth AS ThisMonth;`,
    {
      ingestionId,
      tenantId,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      createdBy: input.createdBy,
      options: JSON.stringify(input.options),
      maxActive: limits.maxActive,
      maxPerMonth: limits.maxPerMonth,
    },
  );
  if (!row) throw new Error("The enqueue answered nothing");
  if (row.Queued === true || row.Queued === 1) return { queued: true, ingestionId };
  return {
    queued: false,
    reached: row.ThisMonth >= limits.maxPerMonth ? "monthly" : "active",
    active: row.Active,
    thisMonth: row.ThisMonth,
  };
}

// The next job of any tenant: queued and due, or running under a lease that
// ran out (its worker died). This is the one statement that spans tenants, by
// design: the cron worker is not a tenant session, and everything it does
// after the claim is scoped by the claimed row's TenantId. READPAST skips a
// row another worker is claiming, UPDLOCK keeps two workers off the same row.
export async function claimNextIngestion(leaseSeconds = LEASE_SECONDS): Promise<ClaimedIngestion | null> {
  const leaseToken = randomUUID();
  const row = await queryOne<ClaimRow>(
    `WITH next AS (
       SELECT TOP (1) *
         FROM lms.AssetIngestion WITH (UPDLOCK, READPAST, ROWLOCK)
        WHERE ${CLAIMABLE}
        ORDER BY NotBefore, CreatedAt
     )
     UPDATE next
       ${CLAIM_SET}`,
    { leaseToken, leaseSeconds },
  );
  return toClaimed(row, leaseToken);
}

// One named job of one tenant, for a caller that runs its own job inline
// (scripts/ingest-youtube.ts).
export async function claimIngestion(
  tenantId: string,
  ingestionId: string,
  leaseSeconds = LEASE_SECONDS,
): Promise<ClaimedIngestion | null> {
  const leaseToken = randomUUID();
  const row = await queryOne<ClaimRow>(
    `UPDATE lms.AssetIngestion WITH (UPDLOCK, READPAST)
       ${CLAIM_SET}
      WHERE IngestionId = @ingestionId AND TenantId = @tenantId
        AND ${CLAIMABLE}`,
    { leaseToken, leaseSeconds, ingestionId, tenantId },
  );
  return toClaimed(row, leaseToken);
}

export interface WorkUpdate {
  stage: IngestionStage;
  workJson: string;
  lessonsDone: number;
  lessonsTotal: number | null;
  warningsJson: string;
  usageJson: string;
}

// Keeps what the job has produced so far and renews the lease. False when the
// lease is no longer this worker's.
export async function saveIngestionWork(
  job: ClaimedIngestion,
  update: WorkUpdate,
  leaseSeconds = LEASE_SECONDS,
): Promise<boolean> {
  const rows = await execute(
    `UPDATE lms.AssetIngestion
        SET Stage = @stage, WorkJson = @work, LessonsDone = @lessonsDone, LessonsTotal = @lessonsTotal,
            WarningsJson = @warnings, UsageJson = @usage, LeaseUntil = DATEADD(second, @leaseSeconds, SYSUTCDATETIME()),
            UpdatedAt = SYSUTCDATETIME()
      WHERE ${HELD}`,
    {
      ...held(job),
      stage: update.stage,
      work: update.workJson,
      lessonsDone: update.lessonsDone,
      lessonsTotal: update.lessonsTotal,
      warnings: update.warningsJson,
      usage: update.usageJson,
      leaseSeconds,
    },
  );
  return rows === 1;
}

// The course is already stamped in ResultCourseId by createCourse's own
// transaction. The work is dropped: the course draft now holds the result.
export async function completeIngestion(job: ClaimedIngestion, usageJson: string): Promise<boolean> {
  const rows = await execute(
    `UPDATE lms.AssetIngestion
        SET Status = 'completed', WorkJson = NULL, ErrorMessage = NULL, UsageJson = @usage,
            LeaseToken = NULL, LeaseUntil = NULL, UpdatedAt = SYSUTCDATETIME()
      WHERE ${HELD} AND ResultCourseId IS NOT NULL`,
    { ...held(job), usage: usageJson },
  );
  return rows === 1;
}

// Neither this nor a requeue touches a job that has its course: that one is
// finished by the next claim, never failed or run again.
export async function failIngestion(job: ClaimedIngestion, message: string, usageJson: string): Promise<boolean> {
  const rows = await execute(
    `UPDATE lms.AssetIngestion
        SET Status = 'failed', ErrorMessage = @message, UsageJson = @usage,
            LeaseToken = NULL, LeaseUntil = NULL, UpdatedAt = SYSUTCDATETIME()
      WHERE ${HELD} AND ResultCourseId IS NULL`,
    { ...held(job), message: message.slice(0, 3500), usage: usageJson },
  );
  return rows === 1;
}

// A transient failure: back in the queue, not before the delay.
export async function requeueIngestion(
  job: ClaimedIngestion,
  delaySeconds: number,
  message: string,
  usageJson: string,
): Promise<boolean> {
  const rows = await execute(
    `UPDATE lms.AssetIngestion
        SET Status = 'queued', NotBefore = DATEADD(second, @delaySeconds, SYSUTCDATETIME()), ErrorMessage = @message,
            UsageJson = @usage,
            LeaseToken = NULL, LeaseUntil = NULL, UpdatedAt = SYSUTCDATETIME()
      WHERE ${HELD} AND ResultCourseId IS NULL`,
    { ...held(job), delaySeconds: Math.round(delaySeconds), message: message.slice(0, 3500), usage: usageJson },
  );
  return rows === 1;
}

// Out of time for this call with stages left: due again at once, and the
// attempt the claim counted is given back, since nothing failed.
export async function pauseIngestion(job: ClaimedIngestion, usageJson: string): Promise<boolean> {
  const rows = await execute(
    `UPDATE lms.AssetIngestion
        SET Status = 'queued', NotBefore = SYSUTCDATETIME(),
            Attempts = CASE WHEN Attempts > 0 THEN Attempts - 1 ELSE 0 END, UsageJson = @usage,
            LeaseToken = NULL, LeaseUntil = NULL, UpdatedAt = SYSUTCDATETIME()
      WHERE ${HELD}`,
    { ...held(job), usage: usageJson },
  );
  return rows === 1;
}

// Never WorkJson or OptionsJson: they can hold the source's text.
export async function getIngestion(tenantId: string, ingestionId: string): Promise<IngestionRecord | null> {
  const row = await queryOne<RecordRow>(
    `SELECT ${RECORD_COLUMNS}
       FROM lms.AssetIngestion
      WHERE IngestionId = @ingestionId AND TenantId = @tenantId`,
    { ingestionId, tenantId },
  );
  return row ? toRecord(row) : null;
}

// The job that made a course, for the course editor's banner.
export async function getCourseIngestion(tenantId: string, courseId: string): Promise<IngestionRecord | null> {
  const row = await queryOne<RecordRow>(
    `SELECT TOP (1) ${RECORD_COLUMNS}
       FROM lms.AssetIngestion
      WHERE TenantId = @tenantId AND ResultCourseId = @courseId
      ORDER BY CreatedAt DESC`,
    { tenantId, courseId },
  );
  return row ? toRecord(row) : null;
}

export async function listIngestions(tenantId: string, limit = 20): Promise<IngestionRecord[]> {
  const rows = await query<RecordRow>(
    `SELECT TOP (@limit) ${RECORD_COLUMNS}
       FROM lms.AssetIngestion
      WHERE TenantId = @tenantId
      ORDER BY CreatedAt DESC`,
    { tenantId, limit: Math.max(1, Math.min(100, Math.trunc(limit))) },
  );
  return rows.map(toRecord);
}

function held(job: ClaimedIngestion) {
  return { ingestionId: job.ingestionId, tenantId: job.tenantId, leaseToken: job.leaseToken };
}
