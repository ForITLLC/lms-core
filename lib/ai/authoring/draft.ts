import { randomUUID } from "node:crypto";
import { DraftDoc } from "@/lib/schema/draft";
import type { AuthorableBlock } from "./blocks";
import type { LessonOutline } from "./outline";
import type { LessonQuiz } from "./quiz";

export interface LessonPlan {
  lesson: LessonOutline;
  blocks: AuthorableBlock[];
  quiz: LessonQuiz;
}

// The generated course doesn't fit the course builder's draft as a whole, such
// as a description longer than a draft holds. Nothing has been written.
export class AuthoredDraftError extends Error {}

// The AI course as a course builder draft. Each lesson's quiz is its last
// block, held inline with its questions; a lesson drafted with quizzes off
// has none. Editor keys are fresh lowercase GUIDs, the form the editor and
// toDraftDoc (lib/builder/fork.ts) give them.
export function toAuthoredDraft(
  course: { title: string; description: string },
  plans: LessonPlan[],
  newKey: () => string = randomUUID,
): DraftDoc {
  const parsed = DraftDoc.safeParse({
    meta: { title: course.title, description: course.description },
    lessons: plans.map(({ lesson, blocks, quiz }) => ({
      key: newKey(),
      title: lesson.title,
      estMinutes: lesson.estMinutes,
      blocks: [
        ...blocks.map((block) => ({ ...block, key: newKey() })),
        ...(quiz.questions.length > 0 ? [{ kind: "quiz", key: newKey(), questions: quiz.questions }] : []),
      ],
    })),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AuthoredDraftError(
      `The generated course doesn't fit a course draft at ${describePath(issue?.path ?? [])}: ${issue?.message ?? "invalid"}`,
    );
  }
  return parsed.data;
}

// ["lessons", 1, "blocks", 2, "url"] reads "lesson 2 block 3 url".
const COUNTED = new Map([["lessons", "lesson"], ["blocks", "block"], ["questions", "question"]]);

function describePath(path: (string | number)[]): string {
  const words = path.flatMap((part, i) => {
    if (part === "meta") return ["course"];
    if (typeof part === "string") return COUNTED.has(part) && typeof path[i + 1] === "number" ? [] : [part];
    const counted = COUNTED.get(String(path[i - 1]));
    return [counted ? `${counted} ${part + 1}` : String(part)];
  });
  return words.length ? words.join(" ") : "the course";
}
