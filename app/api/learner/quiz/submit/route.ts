import { after, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/get-session";
import { resolveLearner, ensureEnrollment } from "@/lib/db/progress";
import {
  getQuizForGrading,
  gradeResponses,
  recordAttempt,
  type QuizResponse,
} from "@/lib/db/quizzes";
import { queueAnswerMarking } from "@/lib/ai/grading/queue";
import { kickGrading } from "@/lib/ai/grading/kick";
import { recordExamAttempt } from "@/lib/records/writers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// M4 scoring endpoint. CoursePlayer POSTs a learner's answers for one quiz; we
// grade server-side against the answer key (never trusting a client-computed
// score), persist the attempt, and return the score + pass/fail. Tenant-scoped:
// getQuizForGrading resolves the quiz only within the caller's tenant, and an
// entitled course's quiz only for a learner holding its seat.
export async function POST(req: Request) {
  const session = await getSessionUser();
  if (!session?.tenantId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  let body: { courseId?: string; quizId?: string; responses?: QuizResponse[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { courseId, quizId } = body;
  if (!courseId || !quizId || !Array.isArray(body.responses)) {
    return NextResponse.json(
      { error: "courseId, quizId and responses[] required" },
      { status: 400 },
    );
  }

  const learner = await resolveLearner(
    session.tenantId,
    session.email,
    session.name ?? session.email,
    session.azureOid,
  );
  const quiz = await getQuizForGrading(session.tenantId, learner.learnerId, courseId, quizId);
  if (!quiz || !(await ensureEnrollment(session.tenantId, learner.learnerId, courseId))) {
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  }

  const grade = gradeResponses(quiz.questions, body.responses);
  const attempt = await recordAttempt(
    quiz.quizId,
    learner.learnerId,
    quiz.passingScore,
    quiz.questions,
    body.responses,
    grade,
  );
  await recordExamAttempt(session.tenantId, attempt, grade, body.responses);
  // Written answers go to AI marking only where the tenant turned it on; the
  // mark lands later and stays provisional until an instructor confirms it.
  if ((await queueAnswerMarking(session.tenantId, attempt.attemptId, quiz.questions, body.responses)) > 0) {
    after(kickGrading);
  }

  return NextResponse.json({
    attemptId: attempt.attemptId,
    score: attempt.score,
    passingScore: attempt.passingScore,
    passed: attempt.passed,
    correctCount: grade.correctCount,
    autoGradableCount: grade.autoGradableCount,
    perQuestion: grade.perQuestion.map((p) => ({
      orderIndex: p.orderIndex,
      correct: p.correct,
    })),
  });
}
