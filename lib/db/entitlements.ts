import { execute, queryOne } from "@/lib/db";
import { ENTITLEMENT_LIVE } from "@/lib/db/course-scope";
import { retryDeadlockOnce } from "@/lib/db/deadlock";
import { LISTABLE } from "@/lib/db/marketplace-catalogue";

// The seats one marketplace order line buys (docs/contracts/marketplace-connection.md §3). The
// order line id is the marketplace's and global, so an entitlement is found by it alone; every
// other read and write names a TenantId: the buyer's for seats and slugs, the publisher's for the
// course.

export interface StoredEntitlement {
  EntitlementId: string;
  OrderLineId: string;
  TenantId: string;
  TenantSlug: string;
  CourseId: string;
  VersionId: string;
  Seats: number;
  SeatsAssigned: number;
  AccessUntil: string | null;
  Status: "active" | "closed";
}

export interface BuyerTenant {
  TenantId: string;
  Slug: string;
}

export interface EntitledCourse {
  CourseId: string;
  PublisherTenantId: string;
  Slug: string;
  Listable: boolean;
  VersionServed: boolean;
}

export interface EntitlementInsert {
  orderLineId: string;
  tenantId: string;
  courseId: string;
  versionId: string;
  seats: number;
  accessUntil: string | null;
}

export interface EntitlementUpdate {
  entitlementId: string;
  tenantId: string;
  versionId: string;
  seats: number;
  accessUntil: string | null;
}

// Expects lms.Entitlement aliased as `e` and lms.CourseAssignment as `a`. Unassigning deletes the
// assignment row (lib/db/assignments.ts deleteAssignment), and the readers of assignments take
// Status = 'active' as live, so a seat is held by an active row carrying this EntitlementId.
export const SEAT_HELD = `a.TenantId = e.TenantId AND a.EntitlementId = e.EntitlementId AND a.Status = 'active'`;

function liveAssignments(hint = ""): string {
  return `(SELECT COUNT(*) FROM lms.CourseAssignment a ${hint}
            WHERE ${SEAT_HELD})`;
}

export async function findEntitlement(orderLineId: string): Promise<StoredEntitlement | null> {
  return queryOne<StoredEntitlement>(
    `SELECT CONVERT(varchar(64), e.EntitlementId) AS EntitlementId, e.OrderLineId,
            CONVERT(varchar(64), e.TenantId) AS TenantId, t.Slug AS TenantSlug,
            CONVERT(varchar(64), e.CourseId) AS CourseId,
            CONVERT(varchar(64), e.VersionId) AS VersionId,
            e.Seats, ${liveAssignments()} AS SeatsAssigned,
            CONVERT(char(10), e.AccessUntil, 23) AS AccessUntil, e.Status
       FROM lms.Entitlement e
       JOIN lms.Tenant t ON t.TenantId = e.TenantId
      WHERE e.OrderLineId = @orderLineId`,
    { orderLineId },
  );
}

// Any active tenant can buy; only a publisher can sell.
export async function resolveBuyerTenant(slug: string): Promise<BuyerTenant | null> {
  return queryOne<BuyerTenant>(
    `SELECT CONVERT(varchar(64), t.TenantId) AS TenantId, t.Slug
       FROM lms.Tenant t
      WHERE t.Slug = @slug AND t.IsActive = 1`,
    { slug },
  );
}

// Unlike the §4 reads, an unlisted course is still found: a refund PUT must keep working after the
// publisher unlists it. Listable and VersionServed carry the §4 rule for the caller to apply.
export async function findEntitledCourse(courseId: string, versionId: string): Promise<EntitledCourse | null> {
  const owner = await queryOne<{ TenantId: string }>(
    `SELECT CONVERT(varchar(64), c.TenantId) AS TenantId FROM lms.Course c WHERE c.CourseId = @courseId`,
    { courseId },
  );
  if (!owner) return null;
  return queryOne<EntitledCourse>(
    `SELECT CONVERT(varchar(64), c.CourseId) AS CourseId,
            CONVERT(varchar(64), c.TenantId) AS PublisherTenantId, c.Slug,
            CAST(CASE WHEN ${LISTABLE} THEN 1 ELSE 0 END AS bit) AS Listable,
            CAST(CASE WHEN v.VersionNumber <= cur.VersionNumber THEN 1 ELSE 0 END AS bit) AS VersionServed
       FROM lms.Course c
       JOIN lms.CourseVersion v ON v.CourseId = c.CourseId AND v.VersionId = @versionId
       LEFT JOIN lms.CourseVersion cur ON cur.VersionId = c.CurrentVersionId AND cur.CourseId = c.CourseId
      WHERE c.TenantId = @tenantId AND c.CourseId = @courseId`,
    { tenantId: owner.TenantId, courseId, versionId },
  );
}

// The LMS opens a course by slug, so a slug must lead the buyer to one course. It clashes with a
// different course the buyer owns, subscribes to from the catalogue, or holds a live entitlement
// to. The entitled course itself is not a clash: a publisher buying its own course, or a second
// order line on the same course.
export async function buyerOwnsCourseSlug(tenantId: string, slug: string, courseId: string): Promise<boolean> {
  const hit = await queryOne<{ Hit: number }>(
    `SELECT TOP 1 1 AS Hit
       FROM lms.Course clash
      WHERE clash.Slug = @slug
        AND clash.CourseId <> @courseId
        AND (
          clash.TenantId = @tenantId
          OR EXISTS (
            SELECT 1 FROM lms.CatalogSubscription s
             WHERE s.TenantId = @tenantId AND s.CourseId = clash.CourseId
          )
          OR EXISTS (
            SELECT 1 FROM lms.Entitlement ent
             WHERE ent.TenantId = @tenantId
               AND ent.CourseId = clash.CourseId
               AND ${ENTITLEMENT_LIVE}
          )
        )`,
    { tenantId, slug, courseId },
  );
  return hit !== null;
}

function isUniqueViolation(err: unknown): boolean {
  const number = (err as { number?: unknown } | null)?.number;
  return number === 2627 || number === 2601;
}

// False when the order line already exists: a concurrent PUT created it first.
export async function insertEntitlement(row: EntitlementInsert): Promise<boolean> {
  try {
    await execute(
      `INSERT INTO lms.Entitlement (OrderLineId, TenantId, CourseId, VersionId, Seats, AccessUntil)
       VALUES (@orderLineId, @tenantId, @courseId, @versionId, @seats, CONVERT(date, @accessUntil, 23))`,
      {
        orderLineId: row.orderLineId,
        tenantId: row.tenantId,
        courseId: row.courseId,
        versionId: row.versionId,
        seats: row.seats,
        accessUntil: row.accessUntil,
      },
    );
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

// The seat guard is part of the UPDATE, so the count and the write are one statement. HOLDLOCK
// makes the count a locking read that holds the entitlement's assignment range until the write
// commits: under read-committed snapshot (Azure SQL's default) a plain subquery reads the rows as
// of statement start and would miss an assignment committed while the UPDATE waited. Status =
// 'active' keeps a close that landed first from being reopened. False when no row changed. The
// count can deadlock with a seat claim (lib/db/assignments.ts) locking the same rows the other way
// round; the loser is retried once.
export async function updateEntitlement(change: EntitlementUpdate): Promise<boolean> {
  const affected = await retryDeadlockOnce(() => execute(
    `UPDATE e
        SET Seats = @seats,
            VersionId = @versionId,
            AccessUntil = CONVERT(date, @accessUntil, 23),
            Status = CASE WHEN @seats = 0 THEN 'closed' ELSE 'active' END,
            ClosedAt = CASE WHEN @seats = 0 THEN SYSUTCDATETIME() ELSE NULL END,
            UpdatedAt = SYSUTCDATETIME()
       FROM lms.Entitlement e
      WHERE e.EntitlementId = @entitlementId
        AND e.TenantId = @tenantId
        AND e.Status = 'active'
        AND @seats >= ${liveAssignments("WITH (HOLDLOCK)")}`,
    {
      entitlementId: change.entitlementId,
      tenantId: change.tenantId,
      versionId: change.versionId,
      seats: change.seats,
      accessUntil: change.accessUntil,
    },
  ));
  return affected === 1;
}
