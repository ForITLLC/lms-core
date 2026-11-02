import { QuizQuestion } from "@/lib/schema/quiz";

// mssql returns uniqueidentifier columns upper case, while a quiz block's
// payload carries its quizId as written (lower case from crypto.randomUUID), so
// both sides are keyed lower case or no quiz ever finds its questions.

export function groupQuizQuestions(
  rows: ReadonlyArray<{ QuizId: string; PayloadJson: string }>,
): Map<string, QuizQuestion[]> {
  const byQuiz = new Map<string, QuizQuestion[]>();
  for (const row of rows) {
    const parsed = QuizQuestion.safeParse(JSON.parse(row.PayloadJson));
    if (!parsed.success) continue;
    const key = row.QuizId.toLowerCase();
    byQuiz.set(key, [...(byQuiz.get(key) ?? []), parsed.data]);
  }
  return byQuiz;
}

export function questionsForQuiz(byQuiz: Map<string, QuizQuestion[]>, quizId: string): QuizQuestion[] {
  return byQuiz.get(quizId.toLowerCase()) ?? [];
}
