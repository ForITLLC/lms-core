-- 0025_catalogue_certificates: certificates for catalogue courses finished
-- before catalogue parity (audit 1.9). issueCertificate returned null for a
-- subscribed course while the enrolment was still marked complete, so those
-- learners finished the course but hold no certificate, and the overdue list
-- and rollups count them as never completed.
--
-- Each one is issued as of the completion date, with the expiry the course
-- schedule gives (lib/db/schedule.ts computeCertExpiresAt) and a serial in the
-- FI-<year>-<8 hex> form. Only cross-tenant enrolments qualify: a tenant's own
-- courses were always certified. Rerunning it inserts nothing new.

INSERT INTO lms.Certificate
  (CertificateId, TenantId, LearnerId, CourseId, SerialNo,
   CourseTitle, LearnerName, IssuedAt, ExpiresAt)
SELECT NEWID(), e.TenantId, e.LearnerId, e.CourseId,
       CONCAT('FI-', YEAR(e.CompletedAt), '-', RIGHT(CONVERT(char(36), NEWID()), 8)),
       c.Title, l.DisplayName, e.CompletedAt,
       CASE
         WHEN c.ScheduleKind = 'annual'
           THEN CAST(DATEFROMPARTS(YEAR(e.CompletedAt) + 1, 1, 31) AS DATETIME2(3))
         WHEN c.ScheduleKind = 'recurring' AND c.RecurrenceMonths > 0
           THEN DATEADD(MONTH, c.RecurrenceMonths, e.CompletedAt)
       END
  FROM lms.Enrollment e
  JOIN lms.Course c  ON c.CourseId = e.CourseId
  JOIN lms.Learner l ON l.LearnerId = e.LearnerId AND l.TenantId = e.TenantId
 WHERE e.CompletedAt IS NOT NULL
   AND c.TenantId <> e.TenantId
   AND NOT EXISTS (
     SELECT 1 FROM lms.Certificate x
      WHERE x.LearnerId = e.LearnerId AND x.CourseId = e.CourseId
   );
GO
