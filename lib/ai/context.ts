import { z } from "zod";
import type { MobileBlock } from "@/lib/mobile/course";

// What a learner's browser may send the tutor. The course text never comes
// from the client: the route loads it for the learner's own tenant and pinned
// version, so a caller can't swap in text of their own.
export const TutorRequest = z.object({
  message: z.string().trim().min(1).max(2000),
  courseSlug: z.string().trim().min(1).max(200),
  lessonId: z.string().trim().min(1).max(64).optional(),
});

export type TutorRequest = z.infer<typeof TutorRequest>;

export interface CorpusLesson {
  lessonId: string;
  title: string;
  blocks: MobileBlock[];
}

export const CORPUS_MAX_CHARS = 300_000;

// Quizzes and role-plays stay out, so the tutor is not an answer key.
function blockText(b: MobileBlock): string | null {
  switch (b.kind) {
    case "text":
    case "callout":
      return b.markdown;
    case "image": {
      const label = [b.alt, b.caption].filter(Boolean).join(" — ");
      return label ? `[Image: ${label}]` : null;
    }
    case "video":
      return b.transcript ? `[Video transcript]\n${b.transcript}` : null;
    case "package":
      return `[Interactive module: ${b.title}]`;
    default:
      return null;
  }
}

export function courseCorpus(courseTitle: string, lessons: CorpusLesson[], currentLessonId?: string): string {
  const header = `# ${courseTitle}`;
  const sections = lessons.map((lesson, i) => {
    const parts = [`\n## Lesson ${i + 1}: ${lesson.title}`];
    for (const block of lesson.blocks) {
      const text = blockText(block);
      if (text) parts.push(text);
    }
    return { lessonId: lesson.lessonId.toLowerCase(), text: parts.join("\n") };
  });
  const corpus = [header, ...sections.map((s) => s.text)].join("\n");
  if (corpus.length <= CORPUS_MAX_CHARS) return corpus;
  // Too long to send whole: the learner's current lesson goes first, so the cut
  // falls on the other lessons before the one they are asking about.
  const current = sections.find((s) => s.lessonId === currentLessonId?.toLowerCase());
  const ordered = current ? [current, ...sections.filter((s) => s !== current)] : sections;
  return `${[header, ...ordered.map((s) => s.text)].join("\n").slice(0, CORPUS_MAX_CHARS)}\n\n[The rest of the course is not included.]`;
}

export function tutorQuestion(lessonTitle: string | null, message: string): string {
  return lessonTitle ? `Current lesson: ${lessonTitle}\n\nLearner asks: ${message}` : `Learner asks: ${message}`;
}
