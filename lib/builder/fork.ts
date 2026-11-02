import { Block } from "@/lib/schema/blocks";
import { DraftDoc, type DraftBlock } from "@/lib/schema/draft";
import { QuizQuestion } from "@/lib/schema/quiz";

// The rows of one published version, as lib/db/course-drafts.ts reads them.
export interface VersionContent {
  course: {
    Title: string;
    Description: string | null;
    Category: string | null;
    Tags: string | null;
    ScheduleKind: string | null;
    RecurrenceMonths: number | null;
    RequiresQuizPass: boolean | null;
  };
  lessons: { LessonId: string; Title: string; OrderIndex: number; EstMinutes: number | null }[];
  blocks: { BlockId: string; LessonId: string; OrderIndex: number; PayloadJson: string }[];
  quizzes: { QuizId: string; BlockId: string; PassingScore: number; IsExam: boolean }[];
  questions: { QuizId: string; OrderIndex: number; PayloadJson: string }[];
}

// The published version holds something the draft can't represent, so the
// builder can't open it without losing it.
export class UnreadableVersionError extends Error {}

export class UnreadableBlockError extends UnreadableVersionError {
  constructor(readonly lesson: number, readonly block: number) {
    super(`Lesson ${lesson}, block ${block} is in a form the course builder can't read.`);
  }
}

// A published version as a draft document. Editor keys are the published row
// ids, so a key stays meaningful in logs; publish mints fresh ids regardless.
export function toDraftDoc(content: VersionContent): DraftDoc {
  const byOrder = <T extends { OrderIndex: number }>(rows: T[]) => [...rows].sort((a, b) => a.OrderIndex - b.OrderIndex);
  const lessons = byOrder(content.lessons).map((lesson, li) => ({
    key: lesson.LessonId.toLowerCase(),
    title: lesson.Title,
    estMinutes: lesson.EstMinutes,
    blocks: byOrder(content.blocks.filter((b) => sameId(b.LessonId, lesson.LessonId))).map((row, bi) =>
      toDraftBlock(content, row, li + 1, bi + 1),
    ),
  }));

  const parsed = DraftDoc.safeParse({
    meta: {
      title: content.course.Title,
      description: content.course.Description ?? "",
      category: content.course.Category,
      tags: parseTags(content.course.Tags),
      scheduleKind: content.course.ScheduleKind,
      recurrenceMonths: content.course.RecurrenceMonths,
      requiresQuizPass: Boolean(content.course.RequiresQuizPass),
    },
    lessons,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new UnreadableVersionError(
      `The published course has ${issue?.path.join(".") || "a value"} outside what the course builder can edit (${issue?.message ?? "invalid"}).`,
    );
  }
  return parsed.data;
}

function toDraftBlock(
  content: VersionContent,
  row: VersionContent["blocks"][number],
  lessonNo: number,
  blockNo: number,
): DraftBlock {
  const key = row.BlockId.toLowerCase();
  const parsed = Block.safeParse(parseJson(row.PayloadJson));
  if (!parsed.success) throw new UnreadableBlockError(lessonNo, blockNo);
  const block = parsed.data;
  if (block.kind !== "quiz") return { ...block, key };

  const quiz = content.quizzes.find((q) => sameId(q.BlockId, row.BlockId));
  if (!quiz) throw new UnreadableBlockError(lessonNo, blockNo);
  const questions = content.questions
    .filter((q) => sameId(q.QuizId, quiz.QuizId))
    .sort((a, b) => a.OrderIndex - b.OrderIndex)
    .map((q) => {
      const question = QuizQuestion.safeParse(parseJson(q.PayloadJson));
      if (!question.success) throw new UnreadableBlockError(lessonNo, blockNo);
      return question.data;
    });
  return { kind: "quiz", key, passingScore: quiz.PassingScore, isExam: Boolean(quiz.IsExam), questions };
}

function parseTags(raw: string | null): string[] {
  const tags = parseJson(raw ?? "[]");
  if (!Array.isArray(tags)) return [];
  return tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
