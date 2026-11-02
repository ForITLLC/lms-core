import { randomUUID } from "node:crypto";
import { query, queryOne } from "@/lib/db";

// A learner's request for an instructor to look again at the mark on one of
// their written answers (migration 0033; docs/plans/2026-10-29-ai-authoring.md,
// slice A5b). Once per answer. An instructor's next mark on the answer
// resolves it (appendInstructorGrade, lib/db/answer-grades.ts); until then
// the answer is back in the staff marking queue with the learner's note.

export type ReviewRequestOutcome = "requested" | "already" | "not_marked" | "not_found";

export interface ReviewRequestRecord {
  questionId: string;
  requestedAt: Date;
  resolvedByGradeId: string | null;
}

const lower = (id: string) => id.toLowerCase();

// The attempt row is locked as appendInstructorGrade locks it, so a request
// and an instructor's mark on the same attempt never interleave: the request
// lands either before the mark, which then resolves it, or after it, and
// stays open for the instructor to see. The audit event carries ids only; the
// note is on the request row.
export async function requestAnswerReview(
  tenantId: string,
  learnerEmail: string,
  request: { attemptId: string; questionId: string; note: string | null },
): Promise<{ outcome: ReviewRequestOutcome; requestId: string | null }> {
  const requestId = randomUUID();
  const attemptId = lower(request.attemptId);
  const questionId = lower(request.questionId);
  const row = await queryOne<{ Outcome: ReviewRequestOutcome }>(
    `SET XACT_ABORT ON;
     BEGIN TRANSACTION;
     DECLARE @outcome nvarchar(16) = N'not_found';
     IF EXISTS (SELECT 1 FROM lms.AnswerResponse r
                  JOIN lms.QuizAttempt a WITH (UPDLOCK, HOLDLOCK) ON a.AttemptId = r.AttemptId
                  JOIN lms.Learner l ON l.LearnerId = a.LearnerId
                 WHERE r.AttemptId = @attemptId AND r.QuestionId = @questionId AND r.MachineScore IS NULL
                   AND l.TenantId = @tenantId AND l.Email = @learnerEmail)
     BEGIN
       SET @outcome = N'not_marked';
       IF EXISTS (SELECT 1 FROM lms.AnswerGrade WHERE TenantId = @tenantId AND AttemptId = @attemptId AND QuestionId = @questionId)
       BEGIN
         SET @outcome = N'already';
         IF NOT EXISTS (SELECT 1 FROM lms.AnswerReviewRequest WITH (UPDLOCK, HOLDLOCK)
                         WHERE TenantId = @tenantId AND AttemptId = @attemptId AND QuestionId = @questionId)
         BEGIN
           INSERT INTO lms.AnswerReviewRequest (RequestId, TenantId, AttemptId, QuestionId, RequestedBy, Note)
           VALUES (@requestId, @tenantId, @attemptId, @questionId, @learnerEmail, @note);
           INSERT INTO lms.AuditEvent (EventId, TenantId, Actor, Verb, ObjectKind, ObjectId, MetaJson)
           VALUES (NEWID(), @tenantId, @learnerEmail, 'quiz.grade.review_requested', 'quiz_attempt', LOWER(CONVERT(varchar(36), @attemptId)), @meta);
           SET @outcome = N'requested';
         END
       END
     END
     COMMIT TRANSACTION;
     SELECT @outcome AS Outcome;`,
    {
      tenantId,
      learnerEmail,
      attemptId,
      questionId,
      requestId,
      note: request.note,
      meta: JSON.stringify({ questionId, requestId }),
    },
  );
  const outcome = row?.Outcome ?? "not_found";
  return { outcome, requestId: outcome === "requested" ? requestId : null };
}

// Every request on one attempt. The caller has already checked the attempt is
// the learner's own (readOwnAttempt).
export async function listReviewRequests(tenantId: string, attemptId: string): Promise<ReviewRequestRecord[]> {
  const rows = await query<{ QuestionId: string; RequestedAt: Date; ResolvedByGradeId: string | null }>(
    `SELECT CONVERT(varchar(36), QuestionId) AS QuestionId, RequestedAt,
            CONVERT(varchar(36), ResolvedByGradeId) AS ResolvedByGradeId
       FROM lms.AnswerReviewRequest
      WHERE TenantId = @tenantId AND AttemptId = @attemptId`,
    { tenantId, attemptId: lower(attemptId) },
  );
  return rows.map((row) => ({
    questionId: lower(row.QuestionId),
    requestedAt: row.RequestedAt,
    resolvedByGradeId: row.ResolvedByGradeId ? lower(row.ResolvedByGradeId) : null,
  }));
}
