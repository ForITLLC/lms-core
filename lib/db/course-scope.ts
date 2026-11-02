// Learner links go by slug and resolve to the tenant's own course
// (getCourseBySlug), so a catalogue or entitled course whose slug the tenant
// also uses for a course of its own is left out everywhere rather than being
// mandatory or certifiable but unreachable.
const NOT_SHADOWED = `NOT EXISTS (
    SELECT 1 FROM lms.Course own_course
     WHERE own_course.TenantId = @tenantId AND own_course.Slug = c.Slug
  )`;

// A subscribed catalogue course counts for a tenant unless it is shadowed.
export const SUBSCRIBED_IN_SCOPE = `(
  c.CourseId IN (
    SELECT CourseId FROM lms.CatalogSubscription WHERE TenantId = @tenantId
  )
  AND ${NOT_SHADOWED}
)`;

// An entitlement is live while it is active and its AccessUntil (the last
// day, a UTC date) has not passed at `at`: server time, or the fixed instant a
// report is computed as of. Expects lms.Entitlement aliased `ent`.
export function entitlementLive(at = "SYSUTCDATETIME()"): string {
  return `ent.Status = 'active'
       AND (ent.AccessUntil IS NULL OR ent.AccessUntil >= CAST(${at} AS date))`;
}

export const ENTITLEMENT_LIVE = entitlementLive();

// Tenant-visible: the tenant holds a live marketplace entitlement to the
// course (docs/contracts/marketplace-connection.md §6). This shows the course
// to operators so they can assign it and report on it; it opens nothing to a
// learner, who needs a seat (seatHeldBy).
export function entitledToTenant(at?: string): string {
  return `(
  EXISTS (
    SELECT 1 FROM lms.Entitlement ent
     WHERE ent.TenantId = @tenantId
       AND ent.CourseId = c.CourseId
       AND ${entitlementLive(at)}
  )
  AND ${NOT_SHADOWED}
)`;
}

export const ENTITLED_TO_TENANT = entitledToTenant();

// Learner-accessible: the learner holds a seat, an active assignment in this
// tenant carrying the EntitlementId of a live entitlement to the course
// (contract §1: operators assign named learners and the seats bound them).
// `learner` is the SQL for the lms.Learner id: @learnerId for one learner, or
// a column when a query spans many.
export function seatHeldBy(learner = "@learnerId", at?: string): string {
  return `(
  EXISTS (
    SELECT 1 FROM lms.CourseAssignment seat
      JOIN lms.Entitlement ent
        ON ent.EntitlementId = seat.EntitlementId AND ent.TenantId = seat.TenantId
     WHERE seat.TenantId = @tenantId
       AND seat.LearnerId = ${learner}
       AND seat.CourseId = c.CourseId
       AND seat.Status = 'active'
       AND ent.CourseId = c.CourseId
       AND ${entitlementLive(at)}
  )
  AND ${NOT_SHADOWED}
)`;
}

// The two course scopes. Both admit the tenant's own courses and its
// subscribed catalogue courses (migration 0014); they differ only on a
// marketplace entitlement (migration 0027). Operator and admin surfaces read
// TENANT_VISIBLE_SCOPE; everything a learner reads or writes for their own
// training reads learnerAccessibleScope. Expects lms.Course aliased as `c` and
// a @tenantId parameter. Learner-side rows (enrollments, certificates,
// assignments) stay filtered on their own TenantId.
export const TENANT_VISIBLE_SCOPE = `(
  c.TenantId = @tenantId
  OR ${SUBSCRIBED_IN_SCOPE}
  OR ${ENTITLED_TO_TENANT}
)`;

// On top of access, a learner opens a published course, or an archived one
// they enrolled in before it was archived (part-way through it, or holding its
// certificate). Never a draft: authors and admins read drafts through
// TENANT_VISIBLE_SCOPE.
function openableBy(learner: string): string {
  return `(
  c.Status = 'published'
  OR (c.Status = 'archived' AND EXISTS (
    SELECT 1 FROM lms.Enrollment opened
     WHERE opened.TenantId = @tenantId
       AND opened.LearnerId = ${learner}
       AND opened.CourseId = c.CourseId
  ))
)`;
}

export function learnerAccessibleScope(learner = "@learnerId", at?: string): string {
  return `(
  (
    c.TenantId = @tenantId
    OR ${SUBSCRIBED_IN_SCOPE}
    OR ${seatHeldBy(learner, at)}
  )
  AND ${openableBy(learner)}
)`;
}

// A course is mandatory when one of this tenant's curricula marks it so.
// Curricula are always read through their TenantId: a catalogue course sits in
// many tenants' curricula. EXISTS keeps one row per course when two curricula
// both mark it. Expects `c` and the @tenantId and @curriculumId parameters
// (@curriculumId NULL means any curriculum).
export const MANDATORY_FOR_TENANT = `EXISTS (
  SELECT 1 FROM lms.CurriculumCourse cc
    JOIN lms.Curriculum cu ON cu.CurriculumId = cc.CurriculumId
   WHERE cc.CourseId = c.CourseId
     AND cu.TenantId = @tenantId
     AND cc.IsMandatory = 1
     AND (@curriculumId IS NULL OR cu.CurriculumId = @curriculumId)
)`;
