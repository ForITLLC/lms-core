export const SESSION_SIZE = 5;
export const RETRIEVAL_SLOTS = 4;

export interface DuePool {
  cardId: string;
  questionId: string;
  courseId: string;
  courseTitle: string;
  courseSlug: string;
  due: Date;
}

export interface NewPool {
  questionId: string;
  courseId: string;
  courseTitle: string;
  courseSlug: string;
}

export interface ReasoningPool {
  drillItemId: string;
  category: string;
}

export interface SessionItem {
  slot: number;
  source: "retrieval" | "reasoning";
  cardId?: string;
  questionId?: string;
  courseId?: string;
  courseTitle?: string;
  courseSlug?: string;
  drillItemId?: string;
  category?: string;
}

export interface AssembleInput {
  dueCards: DuePool[];
  newQuestions: NewPool[];
  reasoningItems: ReasoningPool[];
}

/**
 * Due FSRS cards first (oldest due first), then unseen questions interleaved
 * across courses, up to four retrieval slots; the rest of the five are
 * reasoning items. Fewer than five when the pools run dry.
 */
export function assembleSession(input: AssembleInput): SessionItem[] {
  const retrieval: Omit<SessionItem, "slot">[] = [];

  const due = [...input.dueCards].sort((a, b) => a.due.getTime() - b.due.getTime());
  for (const c of due) {
    if (retrieval.length >= RETRIEVAL_SLOTS) break;
    retrieval.push({
      source: "retrieval",
      cardId: c.cardId,
      questionId: c.questionId,
      courseId: c.courseId,
      courseTitle: c.courseTitle,
      courseSlug: c.courseSlug,
    });
  }

  const byCourse = new Map<string, NewPool[]>();
  for (const q of input.newQuestions) {
    const list = byCourse.get(q.courseId) ?? [];
    list.push(q);
    byCourse.set(q.courseId, list);
  }
  const queues = [...byCourse.values()];
  for (let i = 0; retrieval.length < RETRIEVAL_SLOTS && queues.some((q) => q.length > 0); i++) {
    const q = queues[i % queues.length]?.shift();
    if (!q) continue;
    retrieval.push({
      source: "retrieval",
      questionId: q.questionId,
      courseId: q.courseId,
      courseTitle: q.courseTitle,
      courseSlug: q.courseSlug,
    });
  }

  const reasoning = input.reasoningItems
    .slice(0, SESSION_SIZE - retrieval.length)
    .map((r) => ({ source: "reasoning" as const, drillItemId: r.drillItemId, category: r.category }));

  return [...retrieval, ...reasoning].map((item, slot) => ({ ...item, slot }));
}
