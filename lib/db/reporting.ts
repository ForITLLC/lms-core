import { query } from "@/lib/db";
import { lastCompletedAt } from "@/lib/db/completion";
import { MANDATORY_FOR_TENANT, TENANT_VISIBLE_SCOPE } from "@/lib/db/course-scope";

// Mandatory-training compliance rollup used by the admin dashboard. One row
// per course in the tenant's scope, its own plus subscribed catalogue courses
// (or in a specific curriculum when curriculumId is passed), with denominators
// a compliance officer actually cares about: enrollments, completions, valid
// certificates, expired certificates. Learner rows count this tenant only.
// Only a learner's latest-cycle certificate per course counts.

export interface CourseComplianceRow {
  courseId: string;
  title: string;
  slug: string;
  category: string | null;
  isMandatory: boolean;
  isCatalogue: boolean;
  totalEnrolled: number;
  completed: number;
  pending: number;
  certIssued: number;
  certExpired: number;
}

interface RawRow {
  CourseId: string;
  Title: string;
  Slug: string;
  Category: string | null;
  IsMandatory: number | null;
  IsCatalogue: number;
  TotalEnrolled: number;
  Completed: number;
  CertIssued: number;
  CertExpired: number;
}

export async function getMandatoryCompletionSummary(
  tenantId: string,
  curriculumId?: string,
): Promise<CourseComplianceRow[]> {
  const rows = await query<RawRow>(
    `
    WITH course_set AS (
      SELECT c.CourseId, c.Title, c.Slug, c.Category,
             CASE WHEN @curriculumId IS NULL THEN 0 ELSE cc.IsMandatory END AS IsMandatory,
             CASE WHEN @curriculumId IS NULL THEN 0 ELSE cc.OrderIndex END AS OrderIndex,
             CASE WHEN c.TenantId = @tenantId THEN 0 ELSE 1 END AS IsCatalogue
        FROM lms.Course c
   LEFT JOIN lms.CurriculumCourse cc
          ON cc.CourseId = c.CourseId
         AND cc.CurriculumId = @curriculumId
         AND cc.CurriculumId IN (SELECT CurriculumId FROM lms.Curriculum
                                  WHERE TenantId = @tenantId)
       WHERE ${TENANT_VISIBLE_SCOPE}
         AND (@curriculumId IS NULL OR cc.CurriculumId IS NOT NULL)
    )
    SELECT
      cs.CourseId,
      cs.Title,
      cs.Slug,
      cs.Category,
      cs.IsMandatory,
      cs.IsCatalogue,
      ISNULL(en.TotalEnrolled, 0) AS TotalEnrolled,
      ISNULL(en.Completed,     0) AS Completed,
      ISNULL(ct.CertIssued,    0) AS CertIssued,
      ISNULL(ct.CertExpired,   0) AS CertExpired
    FROM course_set cs
    OUTER APPLY (
      SELECT
        COUNT(*)            AS TotalEnrolled,
        SUM(done.Completed) AS Completed
      FROM lms.Enrollment e
      -- SQL Server cannot aggregate over a subquery (Msg 130): flag each row first.
      CROSS APPLY (SELECT CASE WHEN ${lastCompletedAt("e")} IS NOT NULL THEN 1 ELSE 0 END AS Completed) done
      WHERE e.CourseId = cs.CourseId AND e.TenantId = @tenantId
    ) en
    OUTER APPLY (
      SELECT
        SUM(CASE WHEN c2.RevokedAt IS NULL
                  AND (c2.ExpiresAt IS NULL OR c2.ExpiresAt > SYSUTCDATETIME())
                 THEN 1 ELSE 0 END) AS CertIssued,
        SUM(CASE WHEN c2.RevokedAt IS NULL
                  AND c2.ExpiresAt IS NOT NULL
                  AND c2.ExpiresAt <= SYSUTCDATETIME()
                 THEN 1 ELSE 0 END) AS CertExpired
      FROM lms.Certificate c2
      WHERE c2.CourseId = cs.CourseId AND c2.TenantId = @tenantId
        AND NOT EXISTS (SELECT 1 FROM lms.Certificate newer
                         WHERE newer.LearnerId = c2.LearnerId
                           AND newer.CourseId  = c2.CourseId
                           AND newer.TenantId  = c2.TenantId
                           AND newer.RevokedAt IS NULL
                           AND newer.CycleNo   > c2.CycleNo)
    ) ct
    ORDER BY cs.IsMandatory DESC, cs.OrderIndex, cs.Title
    `,
    { tenantId, curriculumId: curriculumId ?? null },
  );

  return rows.map((r) => ({
    courseId: r.CourseId,
    title: r.Title,
    slug: r.Slug,
    category: r.Category,
    isMandatory: !!r.IsMandatory,
    isCatalogue: !!r.IsCatalogue,
    totalEnrolled: r.TotalEnrolled,
    completed: r.Completed,
    pending: Math.max(0, r.TotalEnrolled - r.Completed),
    certIssued: r.CertIssued,
    certExpired: r.CertExpired,
  }));
}

export interface ComplianceTotals {
  totalLearners: number;
  totalMandatoryCourses: number;
  totalMandatoryEnrollments: number;
  mandatoryCompletions: number;
  certificatesValid: number;
  certificatesExpired: number;
}

export async function getComplianceTotals(
  tenantId: string,
  curriculumId?: string,
): Promise<ComplianceTotals> {
  const rows = await query<{
    TotalLearners: number;
    TotalMandatoryCourses: number;
    TotalMandatoryEnrollments: number;
    MandatoryCompletions: number;
    CertificatesValid: number;
    CertificatesExpired: number;
  }>(
    `
    SELECT
      (SELECT COUNT(*) FROM lms.Learner WHERE TenantId = @tenantId) AS TotalLearners,
      (SELECT COUNT(*) FROM lms.Course c
        WHERE ${TENANT_VISIBLE_SCOPE}
          AND ${MANDATORY_FOR_TENANT}
      ) AS TotalMandatoryCourses,
      (SELECT COUNT(*) FROM lms.Enrollment e
        JOIN lms.Course c ON c.CourseId = e.CourseId
        WHERE e.TenantId = @tenantId
          AND ${TENANT_VISIBLE_SCOPE}
          AND ${MANDATORY_FOR_TENANT}
      ) AS TotalMandatoryEnrollments,
      (SELECT COUNT(*) FROM lms.Enrollment e
        JOIN lms.Course c ON c.CourseId = e.CourseId
        WHERE e.TenantId = @tenantId
          AND ${lastCompletedAt("e")} IS NOT NULL
          AND ${TENANT_VISIBLE_SCOPE}
          AND ${MANDATORY_FOR_TENANT}
      ) AS MandatoryCompletions,
      (SELECT COUNT(*) FROM lms.Certificate cer
        WHERE cer.TenantId = @tenantId
          AND cer.RevokedAt IS NULL
          AND (cer.ExpiresAt IS NULL OR cer.ExpiresAt > SYSUTCDATETIME())
          AND NOT EXISTS (SELECT 1 FROM lms.Certificate newer
                           WHERE newer.LearnerId = cer.LearnerId
                             AND newer.CourseId  = cer.CourseId
                             AND newer.TenantId  = cer.TenantId
                             AND newer.RevokedAt IS NULL
                             AND newer.CycleNo   > cer.CycleNo)
      ) AS CertificatesValid,
      (SELECT COUNT(*) FROM lms.Certificate cer
        WHERE cer.TenantId = @tenantId
          AND cer.RevokedAt IS NULL
          AND cer.ExpiresAt IS NOT NULL
          AND cer.ExpiresAt <= SYSUTCDATETIME()
          AND NOT EXISTS (SELECT 1 FROM lms.Certificate newer
                           WHERE newer.LearnerId = cer.LearnerId
                             AND newer.CourseId  = cer.CourseId
                             AND newer.TenantId  = cer.TenantId
                             AND newer.RevokedAt IS NULL
                             AND newer.CycleNo   > cer.CycleNo)
      ) AS CertificatesExpired
    `,
    { tenantId, curriculumId: curriculumId ?? null },
  );
  const r = rows[0];
  return {
    totalLearners: r?.TotalLearners ?? 0,
    totalMandatoryCourses: r?.TotalMandatoryCourses ?? 0,
    totalMandatoryEnrollments: r?.TotalMandatoryEnrollments ?? 0,
    mandatoryCompletions: r?.MandatoryCompletions ?? 0,
    certificatesValid: r?.CertificatesValid ?? 0,
    certificatesExpired: r?.CertificatesExpired ?? 0,
  };
}
