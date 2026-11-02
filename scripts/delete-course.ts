#!/usr/bin/env tsx
import "dotenv/config";
import { execute, query, queryOne } from "@/lib/db";

async function main() {
  const tenantSlug = process.env.TENANT_SLUG ?? "forit";
  const courseSlug = process.argv[2];
  if (!courseSlug) {
    console.error("Usage: tsx scripts/delete-course.ts <course-slug> [TENANT_SLUG=forit]");
    process.exit(1);
  }

  const tenant = await queryOne<{ TenantId: string }>(
    `SELECT TenantId FROM lms.Tenant WHERE Slug = @slug`,
    { slug: tenantSlug },
  );
  if (!tenant) throw new Error(`Tenant '${tenantSlug}' not found`);

  const course = await queryOne<{ CourseId: string; Title: string }>(
    `SELECT CourseId, Title FROM lms.Course WHERE TenantId = @tenantId AND Slug = @slug`,
    { tenantId: tenant.TenantId, slug: courseSlug },
  );
  if (!course) {
    console.log(`No course '${courseSlug}' for tenant '${tenantSlug}' — nothing to delete.`);
    return;
  }

  const counts = await queryOne<{ Lessons: number; Blocks: number }>(
    `SELECT
       (SELECT COUNT(*) FROM lms.Lesson WHERE CourseId = @courseId) AS Lessons,
       (SELECT COUNT(*) FROM lms.Block WHERE LessonId IN (SELECT LessonId FROM lms.Lesson WHERE CourseId = @courseId)) AS Blocks`,
    { courseId: course.CourseId },
  );

  console.log(`Deleting course '${course.Title}' (${course.CourseId})`);
  console.log(`  lessons: ${counts?.Lessons ?? 0}, blocks: ${counts?.Blocks ?? 0}`);

  await execute(
    `UPDATE lms.AssetIngestion SET ResultCourseId = NULL WHERE ResultCourseId = @courseId`,
    { courseId: course.CourseId },
  );

  await execute(`DELETE FROM lms.Course WHERE CourseId = @courseId`, {
    courseId: course.CourseId,
  });

  console.log("✓ deleted (cascade removed lessons, blocks, quizzes, questions)");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("✗ delete failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
