import { listCoursesForTenant, getCourseBySlug } from "@/lib/db/courses";
import { resolveCourseInScope, getCourseLearnerStatus } from "@/lib/db/courseAdmin";
import { listLearnersForTenant } from "@/lib/db/learners";
import { getMandatoryCompletionSummary, getComplianceTotals } from "@/lib/db/reporting";

// Read models served by /api/v1 — the surface the for-mcp gateway mounts as
// the forit_learn_* tool family. Everything is read-only and scoped to the
// tenantId the bearer key resolved to (lib/api/bearer.ts).

export async function listCourses(tenantId: string) {
  const courses = await listCoursesForTenant(tenantId, "operator", { includeDrafts: true });
  return courses.map((c) => ({
    title: c.Title,
    slug: c.Slug,
    status: c.Status,
    category: c.Category,
  }));
}

export async function getCourse(tenantId: string, slug: string) {
  const detail = await getCourseBySlug(tenantId, slug, "operator");
  if (!detail) return null;
  return {
    title: detail.course.Title,
    slug: detail.course.Slug,
    status: detail.course.Status,
    lessons: detail.lessons.map((l) => ({
      title: l.Title,
      orderIndex: l.OrderIndex,
      estMinutes: l.EstMinutes,
      blockCount: l.blocks.length,
      quizCount: l.blocks.filter((b) => b.kind === "quiz").length,
    })),
  };
}

export function listLearners(tenantId: string) {
  return listLearnersForTenant(tenantId);
}

export async function getProgress(tenantId: string, slug: string) {
  const course = await resolveCourseInScope(tenantId, slug);
  if (!course) return null;
  const learners = await getCourseLearnerStatus(tenantId, course.courseId);
  return {
    course: { title: course.title, slug: course.slug, status: course.status },
    learnerCount: learners.length,
    completed: learners.filter((l) => l.completedAt !== null).length,
    learners: learners.map((l) => ({
      displayName: l.displayName,
      email: l.email,
      status: l.status,
      pct: l.pct,
      completedAt: l.completedAt,
    })),
  };
}

export async function complianceSummary(tenantId: string) {
  const [totals, courses] = await Promise.all([
    getComplianceTotals(tenantId),
    getMandatoryCompletionSummary(tenantId),
  ]);
  return {
    totals,
    courses: courses.map((c) => ({
      title: c.title,
      slug: c.slug,
      isMandatory: c.isMandatory,
      totalEnrolled: c.totalEnrolled,
      completed: c.completed,
      outstanding: c.pending,
      certificatesValid: c.certIssued,
      certificatesExpired: c.certExpired,
    })),
  };
}
