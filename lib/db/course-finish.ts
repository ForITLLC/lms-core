import { queryOne } from "@/lib/db";
import { issueCertificate } from "@/lib/db/certificates";
import { completeEnrollment, getCourseProgress, type CourseProgress } from "@/lib/db/progress";
import { courseRequiresQuizPass, type CourseQuizGate } from "@/lib/db/quizzes";
import { recordCourseCompletion } from "@/lib/records/writers";

export interface CourseFinish {
  progress: CourseProgress;
  certificate: { serialNo: string } | null;
  quizGate: {
    required: boolean;
    passed: boolean;
    totalQuizzes: number;
    passedQuizzes: number;
    quizzes: Array<{ passingScore: number; bestScore: number | null; passed: boolean }>;
  } | null;
}

// Package blocks in the learner's pinned version with no lms.Progress row. Only
// a satisfied launchable writes that row, so the complete route answers
// package_incomplete while this is above zero.
export async function pendingPackageBlocks(
  tenantId: string,
  learnerId: string,
  courseId: string,
): Promise<number> {
  const row = await queryOne<{ Pending: number }>(
    `SELECT COUNT(*) AS Pending
       FROM lms.Course c
       LEFT JOIN lms.Enrollment e
         ON e.CourseId = c.CourseId AND e.LearnerId = @learnerId
        AND e.TenantId = @tenantId
       JOIN lms.Lesson l
         ON l.CourseId = c.CourseId
        AND l.VersionId = COALESCE(e.VersionId, c.CurrentVersionId)
       JOIN lms.Block b
         ON b.LessonId = l.LessonId
        AND b.VersionId = COALESCE(e.VersionId, c.CurrentVersionId)
      WHERE c.CourseId = @courseId
        AND b.Kind = 'package'
        AND NOT EXISTS (SELECT 1 FROM lms.Progress p
                         WHERE p.LearnerId = @learnerId AND p.BlockId = b.BlockId)`,
    { tenantId, learnerId, courseId },
  );
  return row?.Pending ?? 0;
}

// Completes the enrollment and mints the certificate once every block in the
// learner's pinned version has progress and, where the course requires it,
// every eligible quiz is passed. `gate` is the caller's eligible-quiz roll-up.
export async function finishCourseIfDone(
  tenantId: string,
  learnerId: string,
  learnerName: string,
  courseId: string,
  gate: CourseQuizGate,
): Promise<CourseFinish> {
  const progress = await getCourseProgress(learnerId, courseId);

  let certificate: CourseFinish["certificate"] = null;
  let quizGate: CourseFinish["quizGate"] = null;

  if (progress.completed) {
    // Every quiz requires a submitted attempt; only courses that require a
    // passing score additionally block completion for a failed attempt.
    const requiresPass = await courseRequiresQuizPass(courseId);
    let mayComplete = true;
    if (requiresPass) {
      mayComplete = gate.passed;
      quizGate = {
        required: true,
        passed: gate.passed,
        totalQuizzes: gate.totalQuizzes,
        passedQuizzes: gate.passedQuizzes,
        quizzes: gate.quizzes.map((q) => ({
          passingScore: q.passingScore,
          bestScore: q.bestScore,
          passed: q.passed,
        })),
      };
    }
    if (mayComplete) {
      if (await completeEnrollment(learnerId, courseId)) await recordCourseCompletion(tenantId, learnerId, courseId);
      const cert = await issueCertificate(tenantId, learnerId, learnerName, courseId);
      if (cert) certificate = { serialNo: cert.SerialNo };
    }
  }

  return { progress, certificate, quizGate };
}
