import { z } from "zod";
import { CalloutBlock, EmbedBlock, ImageBlock, PackageBlock, RoleplayBlock, TextBlock, VideoBlock } from "./blocks";
import { QuizQuestion } from "./quiz";

// The course builder's working copy (docs/plans/2026-10-28-course-builder-mvp.md):
// one JSON document per course in lms.CourseDraft. A draft may be incomplete;
// publishProblems says what stops it publishing. Lessons and blocks carry an
// editor key that stays put across saves; database ids are minted at publish.
export const DRAFT_LIMITS = {
  lessons: 100,
  blocksPerLesson: 60,
  questionsPerQuiz: 50,
  docBytes: 1_500_000,
} as const;

// lms.Course.Category is NVARCHAR(32); the editor's settings panel checks against these too.
export const META_LIMITS = {
  category: 32,
  tag: 40,
  tags: 20,
  recurrenceMonths: 120,
} as const;

export const DraftKey = z.string().regex(/^[A-Za-z0-9-]{1,36}$/);

// A quiz is held inline with its questions; publish writes lms.Quiz and
// lms.QuizQuestion rows and the block's { kind: "quiz", quizId } payload.
// isExam is lms.Quiz.IsExam: only an exam's attempts become training records,
// and an exam's attempts can't be deleted (migration 0035).
export const DraftQuizBlock = z.object({
  kind: z.literal("quiz"),
  passingScore: z.number().int().min(1).max(100).default(70),
  isExam: z.boolean().default(false),
  questions: z.array(QuizQuestion).max(DRAFT_LIMITS.questionsPerQuiz),
});

const keyed = { key: DraftKey };

export const DraftBlock = z.discriminatedUnion("kind", [
  TextBlock.extend(keyed),
  ImageBlock.extend(keyed),
  VideoBlock.extend(keyed),
  EmbedBlock.extend(keyed),
  CalloutBlock.extend(keyed),
  DraftQuizBlock.extend(keyed),
  RoleplayBlock.extend(keyed),
  PackageBlock.extend(keyed),
]);
export type DraftBlock = z.infer<typeof DraftBlock>;

// The slug is not here: it is set when the course is created and stays fixed.
export const DraftMeta = z.object({
  title: z.string().max(256),
  description: z.string().max(8000).default(""),
  category: z.string().trim().max(META_LIMITS.category).nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(META_LIMITS.tag)).max(META_LIMITS.tags).default([]),
  scheduleKind: z.enum(["annual", "recurring"]).nullable().default(null),
  recurrenceMonths: z.number().int().min(1).max(META_LIMITS.recurrenceMonths).nullable().default(null),
  requiresQuizPass: z.boolean().default(false),
});
export type DraftMeta = z.infer<typeof DraftMeta>;

export const DraftLesson = z.object({
  key: DraftKey,
  title: z.string().max(256),
  estMinutes: z.number().int().min(1).max(600).nullable().default(null),
  blocks: z.array(DraftBlock).max(DRAFT_LIMITS.blocksPerLesson),
});
export type DraftLesson = z.infer<typeof DraftLesson>;

export const DraftDoc = z
  .object({
    meta: DraftMeta,
    lessons: z.array(DraftLesson).max(DRAFT_LIMITS.lessons),
  })
  .superRefine((doc, ctx) => {
    const seen = new Set<string>();
    const claim = (key: string, path: (string | number)[]) => {
      if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `key ${key} is used twice` });
      seen.add(key);
    };
    doc.lessons.forEach((lesson, li) => {
      claim(lesson.key, ["lessons", li, "key"]);
      lesson.blocks.forEach((block, bi) => claim(block.key, ["lessons", li, "blocks", bi, "key"]));
    });
    if (draftBytes(doc) > DRAFT_LIMITS.docBytes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: "the draft is too large to save" });
    }
  });
export type DraftDoc = z.infer<typeof DraftDoc>;

export function draftBytes(doc: unknown): number {
  return Buffer.byteLength(JSON.stringify(doc), "utf8");
}

export function emptyDraft(meta: Partial<DraftMeta> & { title: string }): DraftDoc {
  return DraftDoc.parse({ meta, lessons: [] });
}

export interface PublishProblem {
  where: string;
  problem: string;
}

// What stops a draft becoming a published version. A draft saves with any of
// these; publish refuses until the list is empty.
export function publishProblems(doc: DraftDoc): PublishProblem[] {
  const problems: PublishProblem[] = [];
  const add = (where: string, problem: string) => problems.push({ where, problem });

  if (!doc.meta.title.trim()) add("Course", "The course has no title.");
  if (doc.meta.scheduleKind === "recurring" && !doc.meta.recurrenceMonths) {
    add("Course", "A recurring course needs the number of months between renewals.");
  }
  if (doc.lessons.length === 0) add("Course", "Add at least one lesson.");

  doc.lessons.forEach((lesson, li) => {
    const lessonWhere = `Lesson ${li + 1}`;
    if (!lesson.title.trim()) add(lessonWhere, "The lesson has no title.");
    if (lesson.blocks.length === 0) add(lessonWhere, "The lesson has no content.");
    lesson.blocks.forEach((block, bi) => {
      const where = `${lessonWhere}, block ${bi + 1}`;
      switch (block.kind) {
        case "text":
        case "callout":
          if (!block.markdown.trim()) add(where, "The text is empty.");
          break;
        case "roleplay":
          if (!block.persona.trim() || !block.scenario.trim() || !block.rubricMd.trim()) {
            add(where, "The role-play needs a persona, a scenario and a rubric.");
          }
          break;
        case "quiz":
          if (block.questions.length === 0) add(where, "The quiz has no questions.");
          block.questions.forEach((question, qi) => {
            for (const problem of questionProblems(question)) add(`${where}, question ${qi + 1}`, problem);
          });
          break;
      }
    });
  });
  return problems;
}

function questionProblems(question: QuizQuestion): string[] {
  const problems: string[] = [];
  if (!question.promptMd.trim()) problems.push("The question has no wording.");
  if (question.kind === "mcq" || question.kind === "multi" || question.kind === "confidence") {
    const ids = question.choices.map((c) => c.id);
    if (new Set(ids).size !== ids.length) problems.push("Two answers share an id.");
    if (question.choices.some((c) => !c.label.trim())) problems.push("An answer is empty.");
    const correct = question.kind === "multi" ? question.correctChoiceIds : [question.correctChoiceId];
    if (correct.some((id) => !ids.includes(id))) problems.push("The correct answer is not one of the answers.");
    if (question.kind === "multi" && new Set(correct).size !== correct.length) {
      problems.push("A correct answer is listed twice.");
    }
  }
  if (question.kind === "short" && !question.rubricMd.trim()) problems.push("The question has no marking rubric.");
  return problems;
}
