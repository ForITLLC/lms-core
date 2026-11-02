import { execute, query, queryOne } from "@/lib/db";
import { TENANT_VISIBLE_SCOPE } from "@/lib/db/course-scope";

// Curriculum management. A tenant's default curriculum (IsDefault = 1) is the
// bundle every learner is measured against; its rows carry IsMandatory to
// separate required training (phishing) from optional primers. Tables and the
// one-default-per-tenant filtered index come from migration 0002.

export interface CurriculumRef {
  curriculumId: string;
  name: string;
  slug: string;
}

// Lazily creates the tenant's default curriculum so seeding the first course
// never depends on a separate provisioning step. The filtered unique index
// UX_lms_Curriculum_OneDefault guarantees the MERGE can match at most one row.
export async function ensureDefaultCurriculum(
  tenantId: string,
  name = "Required Training",
  slug = "default",
): Promise<CurriculumRef> {
  await execute(
    `MERGE lms.Curriculum AS target
     USING (SELECT @tenantId AS TenantId) AS src
       ON target.TenantId = src.TenantId AND target.IsDefault = 1
     WHEN NOT MATCHED THEN
       INSERT (CurriculumId, TenantId, Name, Slug, IsDefault)
       VALUES (NEWID(), @tenantId, @name, @slug, 1);`,
    { tenantId, name, slug },
  );
  const row = await queryOne<{
    CurriculumId: string;
    Name: string;
    Slug: string;
  }>(
    `SELECT CurriculumId, Name, Slug FROM lms.Curriculum
      WHERE TenantId = @tenantId AND IsDefault = 1`,
    { tenantId },
  );
  if (!row) throw new Error("Default curriculum upsert failed");
  return { curriculumId: row.CurriculumId, name: row.Name, slug: row.Slug };
}

export async function getDefaultCurriculum(
  tenantId: string,
): Promise<CurriculumRef | null> {
  const row = await queryOne<{
    CurriculumId: string;
    Name: string;
    Slug: string;
  }>(
    `SELECT CurriculumId, Name, Slug FROM lms.Curriculum
      WHERE TenantId = @tenantId AND IsDefault = 1`,
    { tenantId },
  );
  return row
    ? { curriculumId: row.CurriculumId, name: row.Name, slug: row.Slug }
    : null;
}

// Adds a course to a curriculum, or updates its mandatory flag / ordering.
export async function setCurriculumCourse(
  curriculumId: string,
  courseId: string,
  opts: { isMandatory?: boolean; orderIndex?: number } = {},
): Promise<void> {
  await execute(
    `MERGE lms.CurriculumCourse AS target
     USING (SELECT @curriculumId AS CurriculumId, @courseId AS CourseId) AS src
       ON target.CurriculumId = src.CurriculumId AND target.CourseId = src.CourseId
     WHEN MATCHED THEN UPDATE
       SET IsMandatory = @isMandatory, OrderIndex = @orderIndex
     WHEN NOT MATCHED THEN
       INSERT (CurriculumId, CourseId, IsMandatory, OrderIndex)
       VALUES (@curriculumId, @courseId, @isMandatory, @orderIndex);`,
    {
      curriculumId,
      courseId,
      isMandatory: opts.isMandatory ?? false,
      orderIndex: opts.orderIndex ?? 0,
    },
  );
}

export async function removeCurriculumCourse(
  curriculumId: string,
  courseId: string,
): Promise<void> {
  await execute(
    `DELETE FROM lms.CurriculumCourse
      WHERE CurriculumId = @curriculumId AND CourseId = @courseId`,
    { curriculumId, courseId },
  );
}

export interface CurriculumCourseRow {
  CourseId: string;
  Title: string;
  Slug: string;
  Description: string | null;
  Status: string;
  Category: string | null;
  IsMandatory: boolean;
  OrderIndex: number;
}

// The tenant's default-curriculum courses, mandatory first then by OrderIndex.
// Backs the admin curriculum editor, so an entitled course shows while the
// tenant's entitlement is live; learners reach curriculum courses through the
// dashboard, which needs their seat. A catalogue course drops out once the
// tenant unsubscribes.
export async function getDefaultCurriculumCourses(
  tenantId: string,
): Promise<CurriculumCourseRow[]> {
  return query<CurriculumCourseRow>(
    `SELECT c.CourseId, c.Title, c.Slug, c.Description, c.Status, c.Category,
            cc.IsMandatory, cc.OrderIndex
       FROM lms.CurriculumCourse cc
       JOIN lms.Curriculum cur ON cur.CurriculumId = cc.CurriculumId
       JOIN lms.Course c ON c.CourseId = cc.CourseId
      WHERE cur.TenantId = @tenantId AND cur.IsDefault = 1
        AND ${TENANT_VISIBLE_SCOPE}
      ORDER BY cc.IsMandatory DESC, cc.OrderIndex ASC, c.Title ASC`,
    { tenantId },
  );
}

// AAD-group bindings on a curriculum (migration 0003 — lms.CurriculumGroup).
// The default curriculum is implicit for every learner; this table layers
// additional bindings so e.g. an HR-Compliance curriculum is required only of
// members of the matching HR security group. Authoritative membership lives
// in AAD/forit-HR — the LMS only stores the group id and trusts the AAD
// `groups` claim resolved at sign-in (LmsSession.groups).

export async function listCurriculumGroups(
  curriculumId: string,
): Promise<string[]> {
  const rows = await query<{ AdGroupId: string }>(
    `SELECT AdGroupId FROM lms.CurriculumGroup
      WHERE CurriculumId = @curriculumId
      ORDER BY AdGroupId ASC`,
    { curriculumId },
  );
  return rows.map((r) => r.AdGroupId);
}

export async function addCurriculumGroup(
  curriculumId: string,
  adGroupId: string,
): Promise<void> {
  await execute(
    `MERGE lms.CurriculumGroup AS target
     USING (SELECT @curriculumId AS CurriculumId, @adGroupId AS AdGroupId) AS src
       ON target.CurriculumId = src.CurriculumId AND target.AdGroupId = src.AdGroupId
     WHEN NOT MATCHED THEN
       INSERT (CurriculumId, AdGroupId) VALUES (@curriculumId, @adGroupId);`,
    { curriculumId, adGroupId },
  );
}

export async function removeCurriculumGroup(
  curriculumId: string,
  adGroupId: string,
): Promise<void> {
  await execute(
    `DELETE FROM lms.CurriculumGroup
      WHERE CurriculumId = @curriculumId AND AdGroupId = @adGroupId`,
    { curriculumId, adGroupId },
  );
}

// Returns the additional curricula (beyond the tenant default) a learner is
// required to complete, based on AAD security-group memberships stamped on
// the session at sign-in. Empty `groupIds` means "no extra bindings apply".
export async function getCurriculaForGroups(
  tenantId: string,
  groupIds: string[],
): Promise<CurriculumRef[]> {
  if (groupIds.length === 0) return [];
  // Parameterized IN clause: build @g0,@g1,... params + a placeholder list
  // since lib/db takes no array parameters.
  const params: Record<string, string> = { tenantId };
  const placeholders = groupIds.map((id, i) => {
    params[`g${i}`] = id;
    return `@g${i}`;
  });
  const rows = await query<{
    CurriculumId: string;
    Name: string;
    Slug: string;
  }>(
    `SELECT DISTINCT cur.CurriculumId, cur.Name, cur.Slug
       FROM lms.CurriculumGroup cg
       JOIN lms.Curriculum cur ON cur.CurriculumId = cg.CurriculumId
      WHERE cur.TenantId = @tenantId
        AND cg.AdGroupId IN (${placeholders.join(",")})
        AND cur.IsDefault = 0`,
    params,
  );
  return rows.map((r) => ({
    curriculumId: r.CurriculumId,
    name: r.Name,
    slug: r.Slug,
  }));
}
