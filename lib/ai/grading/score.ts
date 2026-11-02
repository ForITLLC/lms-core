import { markDecidesPass } from "./policy";

// An attempt's score once its written answers have marks
// (docs/plans/2026-10-29-ai-authoring.md, slice A5a). Every question weighs the
// same, as the auto-marked ones always have: a written answer adds its mark
// over its maximum, so 3 of 5 counts as 0.6 of a question. An answer with no
// mark is left out, exactly as before marks existed.
//
// Two scores come out. `score` decides pass or fail and is what
// lms.QuizAttempt.Score holds: the auto-marked questions plus each written
// answer whose mark may decide (policy.ts, Q3). `provisionalScore` counts
// every written answer that has a mark, the AI's included, for display only.

export type GradeSource = "ai" | "instructor";

export interface GradeRecord {
  gradeId: string;
  questionId: string;
  seq: number;
  source: GradeSource;
  score: number;
  maxScore: number;
  feedbackMd: string | null;
  model: string | null;
  promptVersion: string | null;
  gradedBy: string | null;
  gradedAt: Date;
  reason: string | null;
  confirmsGradeId: string | null;
}

export interface AttemptAnswer {
  questionId: string;
  orderIndex: number;
  // 1 or 0 for an auto-marked question; null for a written answer.
  machineScore: number | null;
}

export type AnswerStatus =
  | "auto"
  | "awaiting_instructor"
  | "ai_provisional"
  | "instructor_confirmed"
  | "instructor_marked";

export interface ScoredAnswer {
  questionId: string;
  orderIndex: number;
  status: AnswerStatus;
  score: number | null;
  maxScore: number | null;
  gradeId: string | null;
  feedbackMd: string | null;
  decidesPass: boolean;
}

export interface AttemptScore {
  score: number;
  provisionalScore: number;
  answers: ScoredAnswer[];
}

// The mark an answer stands at: the latest instructor mark, else the latest
// AI mark, which is provisional.
export function standingGrade(grades: readonly GradeRecord[], questionId: string): GradeRecord | null {
  const mine = grades.filter((g) => same(g.questionId, questionId));
  const latest = (source: GradeSource) =>
    mine.filter((g) => g.source === source).reduce<GradeRecord | null>((best, g) => (!best || g.seq > best.seq ? g : best), null);
  return latest("instructor") ?? latest("ai");
}

export function scoreAttempt(answers: readonly AttemptAnswer[], grades: readonly GradeRecord[]): AttemptScore {
  let points = 0;
  let counted = 0;
  let shownPoints = 0;
  let shown = 0;
  const scored: ScoredAnswer[] = [];
  for (const answer of [...answers].sort((a, b) => a.orderIndex - b.orderIndex)) {
    if (answer.machineScore !== null) {
      points += answer.machineScore;
      counted += 1;
      shownPoints += answer.machineScore;
      shown += 1;
      scored.push({ ...base(answer), status: "auto", score: answer.machineScore, maxScore: 1, decidesPass: true });
      continue;
    }
    const grade = standingGrade(grades, answer.questionId);
    if (!grade) {
      scored.push({ ...base(answer), status: "awaiting_instructor", decidesPass: false });
      continue;
    }
    const fraction = grade.score / grade.maxScore;
    const decides = markDecidesPass(grade.source);
    if (decides) {
      points += fraction;
      counted += 1;
    }
    shownPoints += fraction;
    shown += 1;
    scored.push({
      questionId: answer.questionId,
      orderIndex: answer.orderIndex,
      status: grade.source === "ai" ? "ai_provisional" : grade.confirmsGradeId ? "instructor_confirmed" : "instructor_marked",
      score: grade.score,
      maxScore: grade.maxScore,
      gradeId: grade.gradeId,
      feedbackMd: grade.feedbackMd,
      decidesPass: decides,
    });
  }
  return { score: percent(points, counted), provisionalScore: percent(shownPoints, shown), answers: scored };
}

// The same expression gradeResponses (lib/db/quizzes.ts) uses, so an attempt
// with no marks scores exactly what it was recorded with.
function percent(points: number, count: number): number {
  return count > 0 ? Math.round((points / count) * 100) : 0;
}

function base(answer: AttemptAnswer) {
  return { questionId: answer.questionId, orderIndex: answer.orderIndex, score: null, maxScore: null, gradeId: null, feedbackMd: null };
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
