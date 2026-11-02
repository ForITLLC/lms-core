import { randomUUID } from "node:crypto";
import { Block } from "@/lib/schema/blocks";
import { publishProblems, type DraftDoc, type PublishProblem } from "@/lib/schema/draft";

// The rows one publish writes, all with fresh ids. Property names are the
// content tables' column names: lib/db/course-publish.ts inserts them with
// OPENJSON in a single batch.
export interface PublishRows {
  lessons: { LessonId: string; Title: string; OrderIndex: number; EstMinutes: number | null }[];
  blocks: { BlockId: string; LessonId: string; Kind: string; OrderIndex: number; PayloadJson: string }[];
  quizzes: { QuizId: string; BlockId: string; PassingScore: number; IsExam: boolean }[];
  questions: {
    QuestionId: string;
    QuizId: string;
    Kind: string;
    OrderIndex: number;
    PromptMd: string;
    PayloadJson: string;
  }[];
}

export interface PublishCourseFields {
  title: string;
  description: string | null;
  category: string | null;
  tags: string | null;
  scheduleKind: "annual" | "recurring" | null;
  recurrenceMonths: number | null;
  requiresQuizPass: boolean;
}

export interface PublishPlan {
  course: PublishCourseFields;
  rows: PublishRows;
}

export type PlanResult = { ok: true; plan: PublishPlan } | { ok: false; problems: PublishProblem[] };

export function buildPublishPlan(doc: DraftDoc, newId: () => string = randomUUID): PlanResult {
  const problems = publishProblems(doc);
  if (problems.length > 0) return { ok: false, problems };

  const rows: PublishRows = { lessons: [], blocks: [], quizzes: [], questions: [] };
  doc.lessons.forEach((lesson, li) => {
    const LessonId = newId();
    rows.lessons.push({ LessonId, Title: lesson.title.trim(), OrderIndex: li, EstMinutes: lesson.estMinutes });
    lesson.blocks.forEach((block, bi) => {
      const BlockId = newId();
      let payload: unknown;
      if (block.kind === "quiz") {
        const QuizId = newId();
        payload = { kind: "quiz", quizId: QuizId };
        rows.quizzes.push({ QuizId, BlockId, PassingScore: block.passingScore, IsExam: block.isExam });
        block.questions.forEach((question, qi) => {
          rows.questions.push({
            QuestionId: newId(),
            QuizId,
            Kind: question.kind,
            OrderIndex: qi,
            PromptMd: question.promptMd,
            PayloadJson: JSON.stringify(question),
          });
        });
      } else {
        const { key: _key, ...content } = block;
        payload = content;
      }
      const stored = Block.safeParse(payload);
      if (!stored.success) {
        problems.push({ where: `Lesson ${li + 1}, block ${bi + 1}`, problem: "The block can't be published in this form." });
        return;
      }
      rows.blocks.push({ BlockId, LessonId, Kind: stored.data.kind, OrderIndex: bi, PayloadJson: JSON.stringify(stored.data) });
    });
  });
  if (problems.length > 0) return { ok: false, problems };

  const { meta } = doc;
  return {
    ok: true,
    plan: {
      course: {
        title: meta.title.trim(),
        description: meta.description.trim() ? meta.description : null,
        category: meta.category || null,
        tags: meta.tags.length > 0 ? JSON.stringify(meta.tags) : null,
        scheduleKind: meta.scheduleKind,
        recurrenceMonths: meta.scheduleKind === "recurring" ? meta.recurrenceMonths : null,
        requiresQuizPass: meta.requiresQuizPass,
      },
      rows,
    },
  };
}
