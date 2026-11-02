import { createHash } from "node:crypto";
import type { CourseDetail, MaterializedBlock } from "@/lib/db/courses";
import type { GradableQuestion } from "@/lib/db/quizzes";
import { stripBlock, type MobileBlock } from "@/lib/mobile/course";
import type { DraftBlock, DraftDoc } from "@/lib/schema/draft";
import { resolveCourseTokens, type TenantContentTokens } from "@/lib/tenant-tokens";

// The author preview (docs/plans/2026-10-28-course-builder-mvp.md, S5): a draft,
// or the published version as a draft document, turned into the props the
// learner player takes. It goes the learner page's way, tenant tokens resolved
// and then every block through stripBlock, so no answer key or rubric reaches
// the browser. Grading stays on the server (/api/author/courses/[courseId]/draft/grade).

// What is being previewed: a draft at one revision, or one published version.
// The grade route reads the same thing back, so a stale preview is refused.
export type PreviewTarget = { draftId: string; revision: number } | { draftId: null; versionId: string };

export interface PreviewCourse {
  CourseId: string;
  Title: string;
  Slug: string;
}

export type PreviewLesson = Omit<CourseDetail["lessons"][number], "blocks"> & { blocks: MobileBlock[] };

export interface CoursePreview {
  course: PreviewCourse;
  lessons: PreviewLesson[];
  // The player names a quiz by its id; the grade route by the draft block key.
  // Only quizzes with questions: the learner gate counts a quiz by its question
  // rows (lib/db/course-completion.ts), and an empty quiz has no slide.
  quizKeys: Record<string, string>;
  requiresQuizPass: boolean;
  // The preview runs no activity, so each of these holds completion as an
  // unfinished one does for a learner.
  packageBlocks: number;
}

// Preview ids are derived from the course and the editor key, so they stay put
// across reloads but never equal a published row id. A draft copied from a
// version has those row ids as its keys, and a preview id must not name a real
// block if it ever reached a learner endpoint.
export function previewId(courseId: string, role: "lesson" | "block" | "quiz", key: string): string {
  const hex = createHash("sha256").update(`lms-preview\n${courseId.toLowerCase()}\n${role}\n${key}`).digest("hex");
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

function materialize(courseId: string, block: DraftBlock): MaterializedBlock {
  const blockId = previewId(courseId, "block", block.key);
  if (block.kind === "quiz") {
    return { kind: "quiz", blockId, quizId: previewId(courseId, "quiz", block.key), questions: block.questions };
  }
  const { key: _key, ...payload } = block;
  return { ...payload, blockId };
}

export function buildPreview(
  course: { courseId: string; slug: string },
  doc: DraftDoc,
  tokens: TenantContentTokens = {},
): CoursePreview {
  const courseId = course.courseId.toLowerCase();
  const quizKeys: Record<string, string> = {};
  let packageBlocks = 0;
  const detail: CourseDetail = {
    course: {
      CourseId: courseId,
      Title: doc.meta.title,
      Slug: course.slug,
      Description: doc.meta.description,
      Status: "draft",
      Category: doc.meta.category,
      Tags: doc.meta.tags,
      UpdatedAt: new Date(0),
      OwnerUserId: null,
      OwnerGroupId: null,
      OwnerGroupName: null,
      OwnerName: null,
      IsCatalog: false,
      IsCatalogSubscribed: false,
      CurrentVersionId: null,
    },
    versionId: null,
    lessons: doc.lessons.map((lesson, li) => ({
      LessonId: previewId(courseId, "lesson", lesson.key),
      Title: lesson.title,
      OrderIndex: li,
      EstMinutes: lesson.estMinutes,
      blocks: lesson.blocks.map((block) => {
        const materialized = materialize(courseId, block);
        if (materialized.kind === "quiz" && materialized.questions.length > 0) quizKeys[materialized.quizId] = block.key;
        if (materialized.kind === "package") packageBlocks += 1;
        return materialized;
      }),
    })),
  };
  // Same order as app/learn/[slug]/page.tsx: resolve tokens, then strip.
  const resolved = resolveCourseTokens(detail, tokens);
  return {
    course: { CourseId: courseId, Title: resolved.course.Title, Slug: course.slug },
    lessons: resolved.lessons.map((l) => ({ ...l, blocks: l.blocks.map(stripBlock) })),
    quizKeys,
    requiresQuizPass: doc.meta.requiresQuizPass,
    packageBlocks,
  };
}

export type PreviewQuiz =
  | { kind: "quiz"; passingScore: number; questions: GradableQuestion[] }
  | { kind: "missing" }
  | { kind: "not_quiz" };

// A draft quiz block in the shape gradeResponses reads. Questions are graded by
// position, as the player sends them and as publish numbers them.
export function previewQuiz(doc: DraftDoc, blockKey: string): PreviewQuiz {
  for (const lesson of doc.lessons) {
    const block = lesson.blocks.find((b) => b.key === blockKey);
    if (!block) continue;
    if (block.kind !== "quiz") return { kind: "not_quiz" };
    return {
      kind: "quiz",
      passingScore: block.passingScore,
      questions: block.questions.map((question, orderIndex) => ({
        questionId: `${blockKey}:${orderIndex}`,
        orderIndex,
        question,
      })),
    };
  }
  return { kind: "missing" };
}
