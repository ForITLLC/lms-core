import { queryOne } from "@/lib/db";
import { computeCertExpiresAt, type ScheduleKind } from "@/lib/db/schedule";

// Re-certification for recurrent courses
// (docs/plans/2026-10-27-recertification-design.md). An enrolment runs in
// numbered cycles. A completed course whose certificate is near or past its
// expiry opens its next cycle when the learner opens the course: there is no
// timer and no background job.
export const RENEWAL_WINDOW_DAYS = 60;
const DAY_MS = 86_400_000;

export interface HeldCertificate {
  ScheduleKind: ScheduleKind;
  RecurrenceMonths: number | null;
  IssuedAt: Date;
  ExpiresAt: Date;
}

// Due when the certificate is inside its renewal window and finishing now
// would earn a later expiry than the one held. The window is 60 days, or half
// the certificate's validity when that is shorter: an annual course finished
// in December expires on Jan 31 and must not reopen as soon as it is issued.
// An annual course therefore reopens from Jan 1, when a new pass first counts.
export function renewalDue(cert: HeldCertificate, now: Date = new Date()): boolean {
  const issued = new Date(cert.IssuedAt).getTime();
  const expires = new Date(cert.ExpiresAt).getTime();
  const window = Math.min(RENEWAL_WINDOW_DAYS * DAY_MS, (expires - issued) / 2);
  if (now.getTime() < expires - window) return false;
  const next = computeCertExpiresAt(cert.ScheduleKind, cert.RecurrenceMonths, now);
  return next !== null && next.getTime() > expires;
}

// Opens the next cycle when it is due and returns its number, or null when no
// renewal is due. Only the certificate of the enrolment's current cycle can
// make it due, so a cycle whose completion is stamped but whose certificate
// isn't minted yet never reopens. In one transaction:
//   1. the enrolment moves to the next cycle, guarded on the cycle it was read
//      at, so two tabs opening together advance one cycle, not two. It
//      restarts on the course's current version, unless an assignment made
//      after the finished cycle pins one, or the learner holds a marketplace
//      seat: then the entitlement's version, since a publisher's newer version
//      reaches buyers only through the listing (marketplace contract §3);
//   2. the finished cycle's block progress is copied to lms.ProgressHistory
//      and removed from lms.Progress, so the course starts from the top.
// Quiz attempts stay where they are; the quiz gate only counts attempts
// submitted since CycleStartedAt.
export async function openRenewalIfDue(
  tenantId: string,
  learnerId: string,
  courseId: string,
  now: Date = new Date(),
): Promise<number | null> {
  const held = await queryOne<HeldCertificate & { CycleNo: number }>(
    `SELECT e.CycleNo, c.ScheduleKind, c.RecurrenceMonths, latest.IssuedAt, latest.ExpiresAt
       FROM lms.Enrollment e
       JOIN lms.Course c ON c.CourseId = e.CourseId
      CROSS APPLY (
        SELECT TOP 1 cert.IssuedAt, cert.ExpiresAt, cert.CycleNo
          FROM lms.Certificate cert
         WHERE cert.LearnerId = e.LearnerId
           AND cert.CourseId  = e.CourseId
           AND cert.TenantId  = @tenantId
           AND cert.RevokedAt IS NULL
         ORDER BY cert.CycleNo DESC, cert.IssuedAt DESC
      ) latest
      WHERE e.TenantId  = @tenantId
        AND e.LearnerId = @learnerId
        AND e.CourseId  = @courseId
        AND e.CompletedAt IS NOT NULL
        AND c.ScheduleKind IS NOT NULL
        AND latest.CycleNo = e.CycleNo
        AND latest.ExpiresAt IS NOT NULL`,
    { tenantId, learnerId, courseId },
  );
  if (!held || !renewalDue(held, now)) return null;

  const opened = await queryOne<{ Opened: number }>(
    `SET XACT_ABORT ON;
     BEGIN TRANSACTION;
     UPDATE e
        SET CycleNo = e.CycleNo + 1,
            CycleStartedAt = SYSUTCDATETIME(),
            CompletedAt = NULL,
            Status = 'active',
            VersionId = COALESCE(
              (SELECT TOP 1 a.VersionId FROM lms.CourseAssignment a
                WHERE a.TenantId = @tenantId AND a.LearnerId = @learnerId
                  AND a.CourseId = @courseId AND a.Status = 'active'
                  AND a.AssignedAt > e.CompletedAt
                ORDER BY a.AssignedAt DESC),
              (SELECT ent.VersionId FROM lms.CourseAssignment a
                 JOIN lms.Entitlement ent
                   ON ent.EntitlementId = a.EntitlementId AND ent.TenantId = a.TenantId
                WHERE a.TenantId = @tenantId AND a.LearnerId = @learnerId
                  AND a.CourseId = @courseId AND a.Status = 'active'),
              (SELECT c.CurrentVersionId FROM lms.Course c WHERE c.CourseId = @courseId),
              e.VersionId)
       FROM lms.Enrollment e
      WHERE e.TenantId = @tenantId AND e.LearnerId = @learnerId
        AND e.CourseId = @courseId AND e.CycleNo = @cycleNo
        AND e.CompletedAt IS NOT NULL;
     IF @@ROWCOUNT = 1
     BEGIN
       INSERT INTO lms.ProgressHistory (LearnerId, BlockId, CycleNo, CompletedAt, Seconds)
       SELECT p.LearnerId, p.BlockId, @cycleNo, p.CompletedAt, p.Seconds
         FROM lms.Progress p
         JOIN lms.Block  b ON b.BlockId  = p.BlockId
         JOIN lms.Lesson l ON l.LessonId = b.LessonId
        WHERE p.LearnerId = @learnerId AND l.CourseId = @courseId;
       DELETE p
         FROM lms.Progress p
         JOIN lms.Block  b ON b.BlockId  = p.BlockId
         JOIN lms.Lesson l ON l.LessonId = b.LessonId
        WHERE p.LearnerId = @learnerId AND l.CourseId = @courseId;
       COMMIT TRANSACTION;
       SELECT 1 AS Opened;
     END
     ELSE
     BEGIN
       COMMIT TRANSACTION;
       SELECT 0 AS Opened;
     END`,
    { tenantId, learnerId, courseId, cycleNo: held.CycleNo },
  );
  return opened?.Opened ? held.CycleNo + 1 : null;
}
