import { execute, query, queryOne } from "@/lib/db";
import { ENTITLED_TO_TENANT, SUBSCRIBED_IN_SCOPE, TENANT_VISIBLE_SCOPE, learnerAccessibleScope, seatHeldBy } from "@/lib/db/course-scope";
import { Block } from "@/lib/schema/blocks";
import { QuizQuestion } from "@/lib/schema/quiz";
import { groupQuizQuestions, questionsForQuiz } from "@/lib/db/quiz-questions";

export type MaterializedBlock =
  | (Exclude<Block, { kind: "quiz" }> & { blockId: string })
  | {
      kind: "quiz";
      blockId: string;
      quizId: string;
      questions: QuizQuestion[];
    };

export interface CourseListRow {
  CourseId: string;
  Title: string;
  Slug: string;
  Description: string | null;
  Status: string;
  Category: string | null;
  Tags: string[];
  UpdatedAt: Date;
  // Owner (migration 0011) — a course is owned by an instructor (AppUser) OR
  // an AAD group, never both. OwnerName is the resolved display label:
  // AppUser.DisplayName for a person, OwnerGroupName for a group.
  OwnerUserId: string | null;
  OwnerGroupId: string | null;
  OwnerGroupName: string | null;
  OwnerName: string | null;
  // Catalogue (migration 0014). IsCatalog: this course is published to the
  // shared ForIT catalogue. IsCatalogSubscribed: this row surfaced in the
  // caller's tenant via a CatalogSubscription or a marketplace entitlement,
  // i.e. the course is owned by another tenant and is read-only here.
  IsCatalog: boolean;
  IsCatalogSubscribed: boolean;
}

interface CourseListRawRow {
  CourseId: string;
  Title: string;
  Slug: string;
  Description: string | null;
  Status: string;
  Category: string | null;
  Tags: string | null;
  UpdatedAt: Date;
  OwnerUserId: string | null;
  OwnerGroupId: string | null;
  OwnerGroupName: string | null;
  OwnerName: string | null;
  IsCatalog: boolean;
  IsCatalogSubscribed: boolean;
}

// Columns + joins shared by listCoursesForTenant and getCourseBySlug so the
// owner/catalogue projection stays identical between the list and the detail.
const COURSE_SELECT = `
  CONVERT(varchar(64), c.CourseId) AS CourseId,
  c.Title, c.Slug, c.Description, c.Status, c.Category, c.Tags, c.UpdatedAt,
  CONVERT(varchar(64), c.OwnerUserId) AS OwnerUserId,
  c.OwnerGroupId, c.OwnerGroupName,
  CASE WHEN c.OwnerUserId IS NOT NULL THEN ou.DisplayName
       WHEN c.OwnerGroupId IS NOT NULL THEN c.OwnerGroupName
       ELSE NULL END AS OwnerName,
  c.IsCatalog,
  CAST(CASE WHEN c.TenantId = @tenantId THEN 0 ELSE 1 END AS bit) AS IsCatalogSubscribed`;

// Who a course read is for (lib/db/course-scope.ts). An operator sees every
// course the tenant can assign and report on. A learner sees an entitled
// course only while holding its seat; a learner whose lms.Learner id is not
// known passes null and sees no entitled course.
export type CourseAudience = "operator" | { learnerId: string | null };

const learnerOf = (audience: CourseAudience) => (audience === "operator" ? null : audience.learnerId);

function rowToCourse(r: CourseListRawRow): CourseListRow {
  return {
    CourseId: r.CourseId,
    Title: r.Title,
    Slug: r.Slug,
    Description: r.Description,
    Status: r.Status,
    Category: r.Category,
    Tags: parseTags(r.Tags),
    UpdatedAt: r.UpdatedAt,
    OwnerUserId: r.OwnerUserId,
    OwnerGroupId: r.OwnerGroupId,
    OwnerGroupName: r.OwnerGroupName,
    OwnerName: r.OwnerName,
    IsCatalog: !!r.IsCatalog,
    IsCatalogSubscribed: !!r.IsCatalogSubscribed,
  };
}

export async function listCoursesForTenant(
  tenantId: string,
  audience: CourseAudience,
  opts: { includeDrafts?: boolean } = {},
): Promise<CourseListRow[]> {
  // Drafts are only ever shown for the tenant's own courses — a subscriber or
  // buyer never sees another tenant's unpublished course, even in an admin view.
  const ownFilter = opts.includeDrafts
    ? "c.TenantId = @tenantId"
    : "c.TenantId = @tenantId AND c.Status = 'published'";
  const entitled = audience === "operator" ? ENTITLED_TO_TENANT : seatHeldBy();
  const rows = await query<CourseListRawRow>(
    `SELECT ${COURSE_SELECT}
       FROM lms.Course c
       LEFT JOIN lms.AppUser ou ON ou.AppUserId = c.OwnerUserId
      WHERE (${ownFilter})
         OR (${SUBSCRIBED_IN_SCOPE} AND c.Status = 'published')
         OR (${entitled} AND c.Status = 'published')
      ORDER BY c.UpdatedAt DESC`,
    audience === "operator" ? { tenantId } : { tenantId, learnerId: learnerOf(audience) },
  );
  return rows.map(rowToCourse);
}

export function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export interface CourseDetail {
  course: CourseListRow & { CurrentVersionId: string | null };
  // VersionId actually loaded — either the caller's pinned value or the
  // course's CurrentVersionId fallback. Lessons/blocks are filtered to this.
  versionId: string | null;
  lessons: Array<{
    LessonId: string;
    Title: string;
    OrderIndex: number;
    EstMinutes: number | null;
    blocks: MaterializedBlock[];
  }>;
}

// If `pinnedVersionId` is supplied, only Lessons/Blocks/Quizzes tagged with
// that version are loaded — that's how in-flight learners stay on the
// version they enrolled on. If omitted, falls back to the course's
// CurrentVersionId so the catalog/preview pages still work.
//
// The course is resolved within the audience's scope — the caller's own
// courses plus any subscribed catalogue course, and an entitled course for an
// operator or for a learner holding its seat. When a slug collides between an
// own course and another tenant's, the own course wins (ORDER BY below).
export async function getCourseBySlug(
  tenantId: string,
  slug: string,
  audience: CourseAudience,
  pinnedVersionId?: string | null,
): Promise<CourseDetail | null> {
  const scope = audience === "operator" ? TENANT_VISIBLE_SCOPE : learnerAccessibleScope();
  const raw = await queryOne<CourseListRawRow & { CurrentVersionId: string | null }>(
    `SELECT TOP 1 ${COURSE_SELECT},
            CONVERT(varchar(64), c.CurrentVersionId) AS CurrentVersionId
       FROM lms.Course c
       LEFT JOIN lms.AppUser ou ON ou.AppUserId = c.OwnerUserId
      WHERE c.Slug = @slug AND ${scope}
      ORDER BY CASE WHEN c.TenantId = @tenantId THEN 0 ELSE 1 END`,
    audience === "operator" ? { tenantId, slug } : { tenantId, slug, learnerId: learnerOf(audience) },
  );
  if (!raw) return null;
  const course = { ...rowToCourse(raw), CurrentVersionId: raw.CurrentVersionId };

  const versionId = pinnedVersionId ?? course.CurrentVersionId;
  if (!versionId) {
    // Course has no published version yet (shouldn't happen post-0008 backfill).
    return { course, versionId: null, lessons: [] };
  }

  const lessonRows = await query<{
    LessonId: string;
    Title: string;
    OrderIndex: number;
    EstMinutes: number | null;
  }>(
    `SELECT LessonId, Title, OrderIndex, EstMinutes
       FROM lms.Lesson
      WHERE CourseId = @courseId AND VersionId = @versionId
      ORDER BY OrderIndex ASC`,
    { courseId: course.CourseId, versionId },
  );

  if (lessonRows.length === 0) {
    return { course, versionId, lessons: [] };
  }

  const blockRows = await query<{
    BlockId: string;
    LessonId: string;
    OrderIndex: number;
    PayloadJson: string;
  }>(
    `SELECT BlockId, LessonId, OrderIndex, PayloadJson
       FROM lms.Block
      WHERE VersionId = @versionId
        AND LessonId IN (SELECT LessonId FROM lms.Lesson
                          WHERE CourseId = @courseId AND VersionId = @versionId)
      ORDER BY OrderIndex ASC`,
    { courseId: course.CourseId, versionId },
  );

  const quizBlockIds: string[] = [];
  const parsedBlocks = blockRows
    .map((row) => {
      const parsed = Block.safeParse(JSON.parse(row.PayloadJson));
      if (!parsed.success) return null;
      if (parsed.data.kind === "quiz") quizBlockIds.push(row.BlockId);
      return { row, block: parsed.data };
    })
    .filter((x): x is { row: typeof blockRows[number]; block: Block } => x !== null);

  let quizQuestionsByQuizId = new Map<string, QuizQuestion[]>();
  if (quizBlockIds.length > 0) {
    const questionRows = await query<{
      QuizId: string;
      OrderIndex: number;
      PayloadJson: string;
    }>(
      `SELECT q.QuizId, qq.OrderIndex, qq.PayloadJson
         FROM lms.QuizQuestion qq
         JOIN lms.Quiz q ON q.QuizId = qq.QuizId
        WHERE qq.VersionId = @versionId
          AND q.BlockId IN (SELECT BlockId FROM lms.Block
                            WHERE VersionId = @versionId
                              AND Kind = 'quiz'
                              AND LessonId IN (SELECT LessonId FROM lms.Lesson
                                                WHERE CourseId = @courseId
                                                  AND VersionId = @versionId))
        ORDER BY qq.OrderIndex ASC`,
      { courseId: course.CourseId, versionId },
    );
    quizQuestionsByQuizId = groupQuizQuestions(questionRows);
  }

  const blocksByLesson = new Map<string, MaterializedBlock[]>();
  for (const { row, block } of parsedBlocks) {
    const arr = blocksByLesson.get(row.LessonId) ?? [];
    if (block.kind === "quiz") {
      arr.push({
        kind: "quiz",
        blockId: row.BlockId,
        quizId: block.quizId,
        questions: questionsForQuiz(quizQuestionsByQuizId, block.quizId),
      });
    } else {
      arr.push({ ...block, blockId: row.BlockId });
    }
    blocksByLesson.set(row.LessonId, arr);
  }

  return {
    course,
    versionId,
    lessons: lessonRows.map((l) => ({
      ...l,
      blocks: blocksByLesson.get(l.LessonId) ?? [],
    })),
  };
}

export type CourseOwner =
  | { kind: "user"; userId: string }
  | { kind: "group"; groupId: string; groupName: string }
  | { kind: "none" };

// Sets (or clears) a course's owner. Tenant-scoped: a tenant can only set the
// owner of a course it owns — a subscribed catalogue course is read-only here,
// so the UPDATE matches nothing when CourseId belongs to another tenant.
// Returns the number of rows affected (0 = not found / not owned).
export async function setCourseOwner(
  tenantId: string,
  courseId: string,
  owner: CourseOwner,
): Promise<number> {
  return execute(
    `UPDATE lms.Course
        SET OwnerUserId    = @ownerUserId,
            OwnerGroupId   = @ownerGroupId,
            OwnerGroupName = @ownerGroupName
      WHERE CourseId = @courseId AND TenantId = @tenantId`,
    {
      tenantId,
      courseId,
      ownerUserId: owner.kind === "user" ? owner.userId : null,
      ownerGroupId: owner.kind === "group" ? owner.groupId : null,
      ownerGroupName: owner.kind === "group" ? owner.groupName : null,
    },
  );
}
