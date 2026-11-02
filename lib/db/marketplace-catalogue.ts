import { query, queryOne } from "@/lib/db";
import { getCourseBySlug, parseTags, type CourseDetail } from "@/lib/db/courses";
import type { ScheduleKind } from "@/lib/db/schedule";

// The marketplace's read of a publisher's catalogue (docs/contracts/marketplace-connection.md §4).
// Every course read is scoped to the publisher's TenantId. The shared ForIT catalogue
// (lib/db/catalogue.ts) never reads LISTABLE, so a publisher's course stays out of it.

// Expects lms.Course aliased as `c`. An inactive tenant is served nowhere (lib/tenant.ts), so it
// lists nothing either.
export const LISTABLE = `(
  c.Status = 'published'
  AND c.IsCatalog = 1
  AND EXISTS (SELECT 1 FROM lms.Tenant publisher
               WHERE publisher.TenantId = c.TenantId
                 AND publisher.IsPublisher = 1
                 AND publisher.IsActive = 1)
)`;

export interface MarketplacePublisher {
  TenantId: string;
  Slug: string;
  Name: string;
}

export interface CatalogueCourseRow {
  CourseId: string;
  Slug: string;
  VersionId: string;
  VersionNumber: number;
  Title: string;
  Description: string | null;
  Category: string | null;
  Tags: string[];
  EstMinutes: number | null;
  ScheduleKind: ScheduleKind;
  RecurrenceMonths: number | null;
}

type CatalogueCourseRawRow = Omit<CatalogueCourseRow, "Tags"> & { Tags: string | null };

export interface ListableCourse {
  row: CatalogueCourseRow;
  lessons: CourseDetail["lessons"];
}

const PUBLISHER_COLUMNS = `CONVERT(varchar(64), t.TenantId) AS TenantId, t.Slug, t.Name`;

// Expects the version aliased as `v`. EstMinutes is NULL when no lesson of the version has one.
const COURSE_COLUMNS = `
  CONVERT(varchar(64), c.CourseId) AS CourseId, c.Slug,
  CONVERT(varchar(64), v.VersionId) AS VersionId, v.VersionNumber,
  c.Title, c.Description, c.Category, c.Tags, c.ScheduleKind, c.RecurrenceMonths,
  (SELECT SUM(l.EstMinutes) FROM lms.Lesson l
    WHERE l.CourseId = c.CourseId AND l.VersionId = v.VersionId) AS EstMinutes`;

function toRow(raw: CatalogueCourseRawRow): CatalogueCourseRow {
  return { ...raw, Tags: parseTags(raw.Tags) };
}

export async function resolvePublisher(slug: string): Promise<MarketplacePublisher | null> {
  return queryOne<MarketplacePublisher>(
    `SELECT ${PUBLISHER_COLUMNS}
       FROM lms.Tenant t
      WHERE t.Slug = @slug AND t.IsPublisher = 1 AND t.IsActive = 1`,
    { slug },
  );
}

// The detail route names a course, not a publisher, so the owning publisher is resolved first and
// every read after it is scoped to that TenantId.
export async function findCoursePublisher(courseId: string): Promise<MarketplacePublisher | null> {
  return queryOne<MarketplacePublisher>(
    `SELECT ${PUBLISHER_COLUMNS}
       FROM lms.Course c
       JOIN lms.Tenant t ON t.TenantId = c.TenantId
      WHERE c.CourseId = @courseId AND t.IsPublisher = 1 AND t.IsActive = 1`,
    { courseId },
  );
}

export async function listListableCourses(tenantId: string): Promise<CatalogueCourseRow[]> {
  const rows = await query<CatalogueCourseRawRow>(
    `SELECT ${COURSE_COLUMNS}
       FROM lms.Course c
       JOIN lms.CourseVersion v ON v.VersionId = c.CurrentVersionId AND v.CourseId = c.CourseId
      WHERE c.TenantId = @tenantId AND ${LISTABLE}
      ORDER BY c.Title ASC`,
    { tenantId },
  );
  return rows.map(toRow);
}

// versionId null is the current version. Any other version must be one of this course's
// lms.CourseVersion rows numbered at or below the current one: authoring inserts a version row
// before writing its content and promotes it last, so a higher number can be an unfinished draft.
// The content comes from getCourseBySlug, the loader the web player and the iPhone app use.
export async function getListableCourse(
  tenantId: string,
  courseId: string,
  versionId: string | null,
): Promise<ListableCourse | null> {
  const raw = await queryOne<CatalogueCourseRawRow>(
    `SELECT ${COURSE_COLUMNS}
       FROM lms.Course c
       JOIN lms.CourseVersion v
         ON v.CourseId = c.CourseId AND v.VersionId = COALESCE(@versionId, c.CurrentVersionId)
       JOIN lms.CourseVersion cur ON cur.VersionId = c.CurrentVersionId AND cur.CourseId = c.CourseId
      WHERE c.TenantId = @tenantId AND c.CourseId = @courseId AND ${LISTABLE}
        AND v.VersionNumber <= cur.VersionNumber`,
    { tenantId, courseId, versionId },
  );
  if (!raw) return null;
  const detail = await getCourseBySlug(tenantId, raw.Slug, "operator", raw.VersionId);
  if (!detail || detail.course.CourseId.toLowerCase() !== raw.CourseId.toLowerCase()) return null;
  return { row: toRow(raw), lessons: detail.lessons };
}
