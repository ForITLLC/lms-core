// When the learner last finished this course: this cycle's completion, or,
// while a renewal cycle is open, the previous cycle's certificate.
export function lastCompletedAt(e: string): string {
  return `COALESCE(${e}.CompletedAt, (SELECT MAX(prior.IssuedAt) FROM lms.Certificate prior
    WHERE prior.LearnerId = ${e}.LearnerId AND prior.CourseId = ${e}.CourseId
      AND prior.TenantId = ${e}.TenantId AND prior.RevokedAt IS NULL
      AND prior.CycleNo < ${e}.CycleNo))`;
}
