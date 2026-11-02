import type { CourseDetail, MaterializedBlock } from "@/lib/db/courses";
import type { CourseProgress } from "@/lib/db/progress";
import type { QuizQuestion } from "@/lib/schema/quiz";

// The course payload the iPhone app plays. Same pinned version and resolved
// tenant tokens as app/learn/[slug]/page.tsx, with every answer key and
// grading rubric stripped: grading stays on the server
// (POST /api/mobile/quiz/submit), so the device never holds the answers.

export type MobileQuestion =
  | { kind: "mcq" | "confidence"; promptMd: string; choices: Array<{ id: string; label: string }> }
  | { kind: "multi"; promptMd: string; choices: Array<{ id: string; label: string }> }
  | { kind: "tf"; promptMd: string }
  | { kind: "short"; promptMd: string; maxScore: number };

export type MobileBlock =
  | Exclude<MaterializedBlock, { kind: "quiz" } | { kind: "roleplay" } | { kind: "package" }>
  | { kind: "quiz"; blockId: string; quizId: string; questions: MobileQuestion[] }
  | { kind: "roleplay"; blockId: string; persona: string; scenario: string }
  | { kind: "package"; blockId: string; launchableId: string; title: string; standard: "scorm12" | "scorm2004" | "cmi5" };

export interface MobileCourse {
  course: {
    course_id: string;
    slug: string;
    title: string;
    description: string | null;
    category: string | null;
    version_id: string | null;
  };
  lessons: Array<{
    lesson_id: string;
    title: string;
    order_index: number;
    est_minutes: number | null;
    blocks: MobileBlock[];
  }>;
  seen_block_ids: string[];
  submitted_quiz_ids: string[];
  course_completed: boolean;
  progress: CourseProgress;
}

export function stripQuestion(q: QuizQuestion): MobileQuestion {
  switch (q.kind) {
    case "mcq":
    case "confidence":
      return { kind: q.kind, promptMd: q.promptMd, choices: q.choices };
    case "multi":
      return { kind: "multi", promptMd: q.promptMd, choices: q.choices };
    case "tf":
      return { kind: "tf", promptMd: q.promptMd };
    case "short":
      return { kind: "short", promptMd: q.promptMd, maxScore: q.maxScore };
  }
}

export function stripBlock(b: MaterializedBlock): MobileBlock {
  if (b.kind === "quiz") {
    return { kind: "quiz", blockId: b.blockId, quizId: b.quizId, questions: b.questions.map(stripQuestion) };
  }
  if (b.kind === "roleplay") {
    return { kind: "roleplay", blockId: b.blockId, persona: b.persona, scenario: b.scenario };
  }
  if (b.kind === "package") {
    return { kind: "package", blockId: b.blockId, launchableId: b.launchableId, title: b.title, standard: b.standard };
  }
  return b;
}

export function toMobileCourse(
  detail: CourseDetail,
  seenBlockIds: string[],
  progress: CourseProgress,
  submittedQuizIds: string[] = [],
  courseCompleted = false,
): MobileCourse {
  return {
    course: {
      course_id: detail.course.CourseId,
      slug: detail.course.Slug,
      title: detail.course.Title,
      description: detail.course.Description,
      category: detail.course.Category,
      version_id: detail.versionId,
    },
    lessons: [...detail.lessons]
      .sort((a, b) => a.OrderIndex - b.OrderIndex)
      .map((l) => ({
        lesson_id: l.LessonId,
        title: l.Title,
        order_index: l.OrderIndex,
        est_minutes: l.EstMinutes,
        blocks: l.blocks.map(stripBlock),
      })),
    seen_block_ids: seenBlockIds,
    submitted_quiz_ids: submittedQuizIds,
    course_completed: courseCompleted,
    progress,
  };
}
