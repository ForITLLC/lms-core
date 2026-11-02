import { NextRequest, NextResponse } from "next/server";
import {
  getStarterCourseSlugs,
  loadStarterCourses,
} from "@/db/seed/load-starter-courses";
import { getThemeForSlug } from "@/lib/tenant";
import { queryOne } from "@/lib/db";

// One-shot bearer-protected starter-library seeder. Idempotent — every course
// is upserted by (TenantId, Slug); reruns are safe and only fill the gaps.
// Mirrors the gating pattern of /api/cron/learners-sync so the same secret +
// scheduler can hit it; lives under /api/cron/ to avoid middleware's
// session-cookie gate on /api/admin/.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const url = new URL(req.url);
  const slug =
    url.searchParams.get("slug") ??
    process.env.FORIT_TENANT_SLUG ??
    "forit";
  // ?force=slug-a,slug-b  → republish those courses: a new CourseVersion and
  // a fresh content tree. Old versions and the Progress / QuizAttempt rows
  // that reference them are kept, so in-flight learners stay on the version
  // they enrolled on.
  // ?force=all            → republish every course in the starter library.
  const forceParam = url.searchParams.get("force")?.trim() ?? "";
  const forceSlugs = forceParam
    ? new Set(forceParam.split(",").map((s) => s.trim()).filter(Boolean))
    : new Set<string>();
  const forceAll = forceSlugs.has("all");
  const theme = await getThemeForSlug(slug);
  if (!theme) {
    return NextResponse.json(
      { ok: false, error: `tenant '${slug}' not found` },
      { status: 404 },
    );
  }

  const tenantRow = await queryOne<{ TenantId: string }>(
    `SELECT CONVERT(varchar(64), TenantId) AS TenantId FROM lms.Tenant WHERE Slug = @slug`,
    { slug },
  );
  if (!tenantRow) {
    return NextResponse.json(
      { ok: false, error: `tenant row '${slug}' missing` },
      { status: 404 },
    );
  }

  const effectiveForceSlugs = forceAll
    ? new Set(getStarterCourseSlugs())
    : forceSlugs;

  const outcomes = await loadStarterCourses({
    tenantId: tenantRow.TenantId,
    createdBy: "system:cron-seed",
    forceSlugs: effectiveForceSlugs,
  });

  return NextResponse.json({
    ok: true,
    tenant: slug,
    forceSlugs: Array.from(effectiveForceSlugs),
    courses: outcomes.map((o) => ({
      slug: o.slug,
      title: o.title,
      mandatory: o.mandatory,
      status: o.status,
      lessons: o.lessonCount,
      questions: o.questionCount,
    })),
    created: outcomes.filter((o) => o.status === "created").length,
    replaced: outcomes.filter((o) => o.status === "replaced").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
  });
}
