import { queryOne } from "@/lib/db";
import { listCourseVersions, type CourseVersionSummary } from "@/lib/db/courseAdmin";

// The builder's read-only version history of one of the tenant's own courses.
// A course id from another tenant reads as missing, so the route answers 404.

export interface VersionHistory {
  currentVersionId: string | null;
  versions: CourseVersionSummary[];
}

export async function getVersionHistory(tenantId: string, courseId: string): Promise<VersionHistory | null> {
  const course = await queryOne<{ CourseId: string }>(
    `SELECT CONVERT(varchar(36), c.CourseId) AS CourseId
       FROM lms.Course c
      WHERE c.TenantId = @tenantId AND c.CourseId = @courseId`,
    { tenantId, courseId },
  );
  if (!course) return null;
  const versions = (await listCourseVersions(tenantId, courseId)).map((v) => ({ ...v, versionId: v.versionId.toLowerCase() }));
  return { currentVersionId: versions.find((v) => v.isCurrent)?.versionId ?? null, versions };
}
