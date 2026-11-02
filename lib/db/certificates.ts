import { randomBytes } from "node:crypto";
import { execute, query, queryOne } from "@/lib/db";
import { learnerAccessibleScope } from "@/lib/db/course-scope";
import { computeCertExpiresAt, type ScheduleKind } from "@/lib/db/schedule";

// Certificate issuance. A certificate is minted once when a learner finishes a
// course (lib/db/progress.getCourseProgress reports `completed`). The row is an
// immutable record — CourseTitle / LearnerName are denormalized in migration
// 0002 on purpose, so a later rename never rewrites an issued certificate.

export interface Certificate {
  CertificateId: string;
  TenantId: string;
  LearnerId: string;
  CourseId: string;
  SerialNo: string;
  CourseTitle: string;
  LearnerName: string;
  IssuedAt: Date;
  ExpiresAt: Date | null;
  RevokedAt: Date | null;
  CycleNo: number;
}

// Certificate expiry is driven by lms.Course.ScheduleKind +
// lms.Course.RecurrenceMonths (migration 0004). See lib/db/schedule.ts.

const CERT_COLUMNS = `CertificateId, TenantId, LearnerId, CourseId, SerialNo,
                      CourseTitle, LearnerName, IssuedAt, ExpiresAt, RevokedAt, CycleNo`;

// CERT-<year>-<8 hex>. The hex half is an unguessable capability token: the
// public certificate page is reachable by serial alone, so the serial both
// identifies and authorizes. 32 bits of entropy is ample at LMS scale.
function makeSerial(): string {
  const year = new Date().getUTCFullYear();
  return `CERT-${year}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

// Mints the certificate for a learner who finished a course, their tenant's own,
// a subscribed catalogue course or an entitled course they hold a seat on; the
// row carries the learner's TenantId and
// the publisher's schedule drives expiry. One certificate per cycle of the
// enrolment (lib/db/renewal.ts): lms.Certificate has UQ (LearnerId, CourseId,
// CycleNo), so the MERGE inserts at most once per cycle — replaying a completed
// course keeps that cycle's serial and date.
export async function issueCertificate(
  tenantId: string,
  learnerId: string,
  learnerName: string,
  courseId: string,
): Promise<Certificate | null> {
  const course = await queryOne<{
    Title: string;
    ScheduleKind: ScheduleKind;
    RecurrenceMonths: number | null;
  }>(
    `SELECT c.Title, c.ScheduleKind, c.RecurrenceMonths FROM lms.Course c
      WHERE c.CourseId = @courseId AND ${learnerAccessibleScope()}`,
    { courseId, tenantId, learnerId },
  );
  if (!course) return null;

  const expiresAt = computeCertExpiresAt(course.ScheduleKind, course.RecurrenceMonths);

  await execute(
    `MERGE lms.Certificate AS target
     USING (SELECT @learnerId AS LearnerId, @courseId AS CourseId,
                   ISNULL((SELECT e.CycleNo FROM lms.Enrollment e
                            WHERE e.LearnerId = @learnerId AND e.CourseId = @courseId
                              AND e.TenantId = @tenantId), 1) AS CycleNo) AS src
       ON target.LearnerId = src.LearnerId AND target.CourseId = src.CourseId
      AND target.CycleNo = src.CycleNo
     WHEN NOT MATCHED THEN
       INSERT (CertificateId, TenantId, LearnerId, CourseId, SerialNo,
               CourseTitle, LearnerName, ExpiresAt, CycleNo)
       VALUES (NEWID(), @tenantId, @learnerId, @courseId, @serialNo,
               @courseTitle, @learnerName, @expiresAt, src.CycleNo);`,
    {
      tenantId,
      learnerId,
      courseId,
      serialNo: makeSerial(),
      courseTitle: course.Title,
      learnerName,
      expiresAt,
    },
  );

  return getCertificateForCourse(learnerId, courseId);
}

// The latest cycle's certificate.
export async function getCertificateForCourse(
  learnerId: string,
  courseId: string,
): Promise<Certificate | null> {
  return queryOne<Certificate>(
    `SELECT TOP 1 ${CERT_COLUMNS} FROM lms.Certificate
      WHERE LearnerId = @learnerId AND CourseId = @courseId
      ORDER BY CycleNo DESC`,
    { learnerId, courseId },
  );
}

export interface CertificateView extends Certificate {
  TenantSlug: string;
  TenantName: string;
  RenewedAt: Date | null;
}

// Serial-number lookup powers the public certificate page. The serial is an
// unguessable capability token — holding the URL is the proof — so this query
// is intentionally not tenant-scoped (the row carries its own TenantId).
// RenewedAt is the issue date of a later cycle's certificate. Its serial stays
// out: one serial must never lead to another.
export async function getCertificateBySerial(
  serialNo: string,
): Promise<CertificateView | null> {
  return queryOne<CertificateView>(
    `SELECT c.CertificateId, c.TenantId, c.LearnerId, c.CourseId, c.SerialNo,
            c.CourseTitle, c.LearnerName, c.IssuedAt, c.ExpiresAt, c.RevokedAt, c.CycleNo,
            t.Slug AS TenantSlug, t.Name AS TenantName, renewal.IssuedAt AS RenewedAt
       FROM lms.Certificate c
       JOIN lms.Tenant t ON t.TenantId = c.TenantId
      OUTER APPLY (SELECT TOP 1 n.IssuedAt FROM lms.Certificate n
                    WHERE n.LearnerId = c.LearnerId AND n.CourseId = c.CourseId
                      AND n.TenantId = c.TenantId AND n.RevokedAt IS NULL
                      AND n.CycleNo > c.CycleNo
                    ORDER BY n.CycleNo DESC) renewal
      WHERE c.SerialNo = @serialNo`,
    { serialNo },
  );
}

export async function listCertificatesForLearner(
  learnerId: string,
): Promise<Certificate[]> {
  return query<Certificate>(
    `SELECT ${CERT_COLUMNS} FROM lms.Certificate
      WHERE LearnerId = @learnerId AND RevokedAt IS NULL
      ORDER BY IssuedAt DESC`,
    { learnerId },
  );
}
