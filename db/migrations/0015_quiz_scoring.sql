-- forit-LMS — migration 0015: quiz scoring / completion gating (M4 scoring engine).
-- The attempt + answer tables (lms.QuizAttempt, lms.AnswerResponse) and the
-- per-quiz PassingScore already exist (migration 0001). This migration adds the
-- ONE column the scoring engine needs to gate course completion on a passing
-- knowledge check, plus an index that makes "best score for this learner+quiz"
-- a seek. RequiresQuizPass defaults to 0, so every existing course keeps its
-- view-to-complete behavior untouched — only courses that opt in are gated.
-- Idempotent: guarded so re-running is safe.

IF COL_LENGTH('lms.Course', 'RequiresQuizPass') IS NULL
    ALTER TABLE lms.Course
        ADD RequiresQuizPass BIT NOT NULL
            CONSTRAINT DF_lms_Course_RequiresQuizPass DEFAULT (0);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_lms_QuizAttempt_LearnerQuiz'
                 AND object_id = OBJECT_ID('lms.QuizAttempt'))
    CREATE INDEX IX_lms_QuizAttempt_LearnerQuiz
        ON lms.QuizAttempt (LearnerId, QuizId, SubmittedAt) INCLUDE (Score);
GO
