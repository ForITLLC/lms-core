-- 0035_exam_flag: which quizzes are exams, and an exam's attempts are kept
-- (docs/plans/2026-10-29-training-records-design.md §3.2, slice R1b).
-- lms.Quiz.IsExam comes from the author's "This quiz is an exam" box and is
-- written when a version is published. Every quiz already published reads 0,
-- so nothing is an exam until an author says so. The training-record writers
-- record an attempt only when its quiz is an exam.
-- An attempt at an exam is evidence. The INSTEAD OF DELETE trigger on
-- lms.QuizAttempt refuses any DELETE that names one, and the whole statement
-- fails, so a delete that mixes in a practice attempt removes nothing. Any
-- other delete goes through as before, its answers cascading with it.
-- QuizAttempt's own foreign keys don't cascade, so it can carry an INSTEAD OF
-- trigger. The AFTER UPDATE trigger on lms.Quiz refuses turning an exam back
-- into a practice quiz, so the flag can't be cleared to get an attempt
-- deleted; lms.Quiz's key to lms.Block cascades, so its guard is an AFTER
-- trigger. Exam attempts and their answers are otherwise unchanged; the
-- frozen copy of an attempt is R4's ExamAttemptSnapshot.
-- Permissions are unchanged: no GRANT, DENY or REVOKE.

IF COL_LENGTH('lms.Quiz', 'IsExam') IS NULL
    ALTER TABLE lms.Quiz ADD IsExam BIT NOT NULL CONSTRAINT DF_lms_Quiz_IsExam DEFAULT (0);
GO

CREATE OR ALTER TRIGGER lms.TR_lms_QuizAttempt_KeepExams
    ON lms.QuizAttempt
    INSTEAD OF DELETE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM deleted d JOIN lms.Quiz q ON q.QuizId = d.QuizId WHERE q.IsExam = 1)
        THROW 51036, N'An attempt at an exam is kept: lms.QuizAttempt rows for an exam are never deleted.', 1;
    DELETE a FROM lms.QuizAttempt a JOIN deleted d ON d.AttemptId = a.AttemptId;
END;
GO

CREATE OR ALTER TRIGGER lms.TR_lms_Quiz_ExamStays
    ON lms.Quiz
    AFTER UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM deleted d
                WHERE d.IsExam = 1
                  AND NOT EXISTS (SELECT 1 FROM inserted i WHERE i.QuizId = d.QuizId AND i.IsExam = 1))
        THROW 51037, N'An exam stays an exam: lms.Quiz.IsExam never goes from 1 back to 0.', 1;
END;
GO
