import { loadCourseSeed, type LoadCourseResult } from "@/db/seed/course-seed";
import { ensureDefaultCurriculum, setCurriculumCourse } from "@/lib/db/curriculum";
import { STARTER_COURSES } from "@/db/seed/starter-library";

export interface StarterCourseOutcome extends LoadCourseResult {
  title: string;
  mandatory: boolean;
}

export function getStarterCourseSlugs(): string[] {
  return STARTER_COURSES.map((c) => c.slug);
}

// Loads every starter course into a tenant and wires it into that tenant's
// default curriculum. Idempotent end to end: loadCourseSeed skips an existing
// course (returning its id) and setCurriculumCourse is a MERGE — re-running
// only refreshes the mandatory flag / ordering.
export async function loadStarterCourses(opts: {
  tenantId: string;
  createdBy: string;
  // Slugs in this set are force-reseeded (lesson tree wiped + reauthored).
  // Use to roll out content updates after the initial create. Empty/missing
  // = pure idempotent run (skip every existing course).
  forceSlugs?: Set<string>;
}): Promise<StarterCourseOutcome[]> {
  const curriculum = await ensureDefaultCurriculum(opts.tenantId);
  const outcomes: StarterCourseOutcome[] = [];

  for (let i = 0; i < STARTER_COURSES.length; i++) {
    const seed = STARTER_COURSES[i]!;
    const result = await loadCourseSeed(seed, {
      tenantId: opts.tenantId,
      createdBy: opts.createdBy,
      publish: true,
      force: opts.forceSlugs?.has(seed.slug) ?? false,
    });
    await setCurriculumCourse(curriculum.curriculumId, result.courseId, {
      isMandatory: seed.mandatory,
      orderIndex: i,
    });
    outcomes.push({ ...result, title: seed.title, mandatory: seed.mandatory });
  }

  return outcomes;
}
