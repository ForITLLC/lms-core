import { execute, query, queryOne } from "@/lib/db";

// Shared ForIT catalogue (migration 0014). The canonical `forit` tenant flags
// courses IsCatalog=1 to publish them; any other tenant subscribes to
// individual catalogue courses via lms.CatalogSubscription. Subscribed
// courses then surface read-only in the subscriber's /learn and dashboard
// (the union lives in lib/db/courses.ts).
//
// A publisher tenant (lms.Tenant.IsPublisher, migration 0027) may also set
// IsCatalog, which lists the course in the marketplace
// (lib/db/marketplace-catalogue.ts). Every shared-catalogue read and the
// subscription gate here still join on the `forit` tenant, so a publisher's
// course never reaches the shared catalogue.

const FORIT_SLUG = process.env.FORIT_TENANT_SLUG ?? "forit";

export interface CatalogCourseRow {
  CourseId: string;
  Title: string;
  Slug: string;
  Description: string | null;
  Category: string | null;
  LessonCount: number;
  UpdatedAt: Date;
  IsSubscribed: boolean;
}

// Every published ForIT catalogue course, flagged with whether the given
// subscriber tenant has already opted in. Drives /admin/catalogue.
export async function listCatalogCourses(
  subscriberTenantId: string,
): Promise<CatalogCourseRow[]> {
  return query<CatalogCourseRow>(
    `SELECT CONVERT(varchar(64), c.CourseId) AS CourseId,
            c.Title, c.Slug, c.Description, c.Category, c.UpdatedAt,
            ISNULL((SELECT COUNT(*) FROM lms.Lesson l
                     WHERE l.CourseId = c.CourseId
                       AND l.VersionId = c.CurrentVersionId), 0) AS LessonCount,
            CAST(CASE WHEN s.CourseId IS NULL THEN 0 ELSE 1 END AS bit) AS IsSubscribed
       FROM lms.Course c
       JOIN lms.Tenant t ON t.TenantId = c.TenantId AND t.Slug = @foritSlug
       LEFT JOIN lms.CatalogSubscription s
         ON s.CourseId = c.CourseId AND s.TenantId = @subscriberTenantId
      WHERE c.IsCatalog = 1 AND c.Status = 'published'
      ORDER BY c.Title ASC`,
    { foritSlug: FORIT_SLUG, subscriberTenantId },
  );
}

// True when the course exists, is published, is flagged IsCatalog, and is
// owned by the `forit` tenant — the full set of conditions for a tenant to
// be allowed to subscribe to it.
export async function isSubscribableCatalogCourse(
  courseId: string,
): Promise<boolean> {
  const row = await queryOne<{ Ok: number }>(
    `SELECT 1 AS Ok
       FROM lms.Course c
       JOIN lms.Tenant t ON t.TenantId = c.TenantId AND t.Slug = @foritSlug
      WHERE c.CourseId = @courseId
        AND c.IsCatalog = 1 AND c.Status = 'published'`,
    { foritSlug: FORIT_SLUG, courseId },
  );
  return row !== null;
}

// True when the tenant already has a course of its own with this catalogue
// course's slug. Learner links go by slug and open the own course, so the
// subscription would be shadowed (SUBSCRIBED_IN_SCOPE): refuse it instead.
export async function ownCourseUsesCatalogSlug(
  tenantId: string,
  courseId: string,
): Promise<boolean> {
  const row = await queryOne<{ Ok: number }>(
    `SELECT 1 AS Ok
       FROM lms.Course catalogue_course
       JOIN lms.Course own_course
         ON own_course.Slug = catalogue_course.Slug
        AND own_course.TenantId = @tenantId
      WHERE catalogue_course.CourseId = @courseId`,
    { tenantId, courseId },
  );
  return row !== null;
}

// Idempotent subscribe — a tenant opts into one catalogue course. The caller
// must first confirm isSubscribableCatalogCourse; this assumes a valid id.
export async function subscribeToCatalogCourse(
  tenantId: string,
  courseId: string,
  addedBy: string,
): Promise<void> {
  await execute(
    `MERGE lms.CatalogSubscription AS tgt
     USING (SELECT @tenantId AS TenantId, @courseId AS CourseId) AS src
       ON tgt.TenantId = src.TenantId AND tgt.CourseId = src.CourseId
     WHEN NOT MATCHED THEN
       INSERT (TenantId, CourseId, AddedBy)
       VALUES (@tenantId, @courseId, @addedBy);`,
    { tenantId, courseId, addedBy },
  );
}

export async function unsubscribeFromCatalogCourse(
  tenantId: string,
  courseId: string,
): Promise<void> {
  await execute(
    `DELETE FROM lms.CatalogSubscription
      WHERE TenantId = @tenantId AND CourseId = @courseId`,
    { tenantId, courseId },
  );
}

// Publish (or unpublish) one of a tenant's own courses: to the shared
// catalogue for `forit`, to the marketplace for a publisher tenant. The
// UPDATE is double-gated: TenantId must match the caller AND that tenant
// must be `forit` or a publisher. Returns rows affected — 0 means neither
// holds or the caller does not own the course.
export async function setCourseCatalogPublish(
  tenantId: string,
  courseId: string,
  isCatalog: boolean,
): Promise<number> {
  return execute(
    `UPDATE lms.Course
        SET IsCatalog = @isCatalog
      WHERE CourseId = @courseId
        AND TenantId = @tenantId
        AND TenantId IN (SELECT TenantId FROM lms.Tenant
                          WHERE Slug = @foritSlug OR IsPublisher = 1)`,
    { foritSlug: FORIT_SLUG, tenantId, courseId, isCatalog },
  );
}

// True when the given tenant is the canonical `forit` catalogue publisher —
// gates whether the "publish to catalogue" toggle is shown at all.
export async function isForitTenant(tenantId: string): Promise<boolean> {
  const row = await queryOne<{ Ok: number }>(
    `SELECT 1 AS Ok FROM lms.Tenant
      WHERE TenantId = @tenantId AND Slug = @foritSlug`,
    { foritSlug: FORIT_SLUG, tenantId },
  );
  return row !== null;
}
