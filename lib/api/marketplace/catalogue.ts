import { NextResponse } from "next/server";
import type { CatalogueCourseRow, ListableCourse, MarketplacePublisher } from "@/lib/db/marketplace-catalogue";
import type { ScheduleKind } from "@/lib/db/schedule";
import { stripBlock, type MobileBlock } from "@/lib/mobile/course";
import type { MarketplaceCallerGate } from "./auth";
import { marketplaceError } from "./errors";

// The two catalogue reads of docs/contracts/marketplace-connection.md §4. Data access is injected,
// so the route decisions (auth first, then 400, then 404) are testable without a database.

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A tenant slug is the DNS label of <slug>.learn.forit.io.
export const TENANT_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export interface CatalogueItem {
  courseId: string;
  versionId: string;
  versionNumber: number;
  publisher: { tenantSlug: string; name: string };
  title: string;
  description: string | null;
  category: string | null;
  tags: string[];
  estMinutes: number | null;
  recurrenceMonths: number | null;
}

export interface CatalogueCourse extends CatalogueItem {
  outline: Array<{ lessonId: string; title: string; estMinutes: number | null }>;
  preview: { lessonId: string; title: string; blocks: MobileBlock[] } | null;
}

// Mirrors computeCertExpiresAt (lib/db/schedule.ts). An annual course re-certifies by Jan 31 of
// the next calendar year, which a month count can only approximate as 12; a course with no
// ScheduleKind never expires, whatever RecurrenceMonths holds.
export function recurrenceMonths(kind: ScheduleKind, months: number | null): number | null {
  if (kind === "annual") return 12;
  if (kind === "recurring" && months !== null && months > 0) return months;
  return null;
}

export function toCatalogueItem(publisher: MarketplacePublisher, row: CatalogueCourseRow): CatalogueItem {
  return {
    courseId: row.CourseId.toLowerCase(),
    versionId: row.VersionId.toLowerCase(),
    versionNumber: row.VersionNumber,
    publisher: { tenantSlug: publisher.Slug, name: publisher.Name },
    title: row.Title,
    description: row.Description,
    category: row.Category,
    tags: row.Tags,
    estMinutes: row.EstMinutes,
    recurrenceMonths: recurrenceMonths(row.ScheduleKind, row.RecurrenceMonths),
  };
}

// The preview is the first lesson, with the same stripBlock the web player and iPhone app get, so
// no answer key or rubric leaves the LMS. The outline carries no blocks at all.
export function toCatalogueCourse(publisher: MarketplacePublisher, course: ListableCourse): CatalogueCourse {
  const lessons = [...course.lessons].sort((a, b) => a.OrderIndex - b.OrderIndex);
  const first = lessons[0];
  return {
    ...toCatalogueItem(publisher, course.row),
    outline: lessons.map((l) => ({ lessonId: l.LessonId.toLowerCase(), title: l.Title, estMinutes: l.EstMinutes })),
    preview: first
      ? { lessonId: first.LessonId.toLowerCase(), title: first.Title, blocks: first.blocks.map(stripBlock) }
      : null,
  };
}

type Authenticate = (req: Request) => Promise<MarketplaceCallerGate>;

export interface CatalogueListDeps {
  authenticate: Authenticate;
  resolvePublisher(slug: string): Promise<MarketplacePublisher | null>;
  listCourses(tenantId: string): Promise<CatalogueCourseRow[]>;
}

export function createCatalogueListHandler(deps: CatalogueListDeps) {
  return async (req: Request): Promise<Response> => {
    const gate = await deps.authenticate(req);
    if (!gate.ok) return gate.response;
    const [slug, ...repeated] = new URL(req.url).searchParams.getAll("publisher");
    if (slug === undefined || repeated.length > 0 || !TENANT_SLUG.test(slug)) {
      return marketplaceError(400, "invalid_request", "publisher must be one tenant slug");
    }
    const publisher = await deps.resolvePublisher(slug);
    if (!publisher) return marketplaceError(404, "tenant_not_found", `no publisher tenant "${slug}"`);
    const rows = await deps.listCourses(publisher.TenantId);
    return NextResponse.json({ courses: rows.map((row) => toCatalogueItem(publisher, row)) });
  };
}

export interface CatalogueCourseDeps {
  authenticate: Authenticate;
  findCoursePublisher(courseId: string): Promise<MarketplacePublisher | null>;
  getCourse(tenantId: string, courseId: string, versionId: string | null): Promise<ListableCourse | null>;
}

export interface CatalogueCourseContext {
  params: Promise<{ courseId: string }>;
}

export function createCatalogueCourseHandler(deps: CatalogueCourseDeps) {
  return async (req: Request, { params }: CatalogueCourseContext): Promise<Response> => {
    const gate = await deps.authenticate(req);
    if (!gate.ok) return gate.response;
    const { courseId } = await params;
    // `?versionId=` with no value is the contract's own template for "omitted".
    const [versionParam, ...repeated] = new URL(req.url).searchParams.getAll("versionId");
    const versionId = versionParam || null;
    if (!UUID.test(courseId) || repeated.length > 0 || (versionId !== null && !UUID.test(versionId))) {
      return marketplaceError(400, "invalid_request", "courseId and versionId must be uuids");
    }
    const publisher = await deps.findCoursePublisher(courseId);
    const course = publisher ? await deps.getCourse(publisher.TenantId, courseId, versionId) : null;
    if (!publisher || !course) {
      const at = versionId ? ` at version ${versionId}` : "";
      return marketplaceError(404, "course_not_found", `no listable course ${courseId}${at}`);
    }
    return NextResponse.json(toCatalogueCourse(publisher, course));
  };
}
