-- 0033_answer_review_requests: a learner asks an instructor to look again at
-- the mark on one written answer (docs/plans/2026-10-29-ai-authoring.md,
-- slice A5b).
-- One request per answer: the unique key makes a second ask fail rather than
-- queue twice. The instructor's next mark on that answer resolves it, in the
-- same transaction that appends the mark (lib/db/answer-grades.ts), and
-- ResolvedByGradeId names that mark; a request with no resolving mark is open
-- and puts the answer back in the staff marking queue.

IF OBJECT_ID('lms.AnswerReviewRequest', 'U') IS NULL
    CREATE TABLE lms.AnswerReviewRequest (
        RequestId         UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_AnswerReviewRequest PRIMARY KEY,
        TenantId          UNIQUEIDENTIFIER NOT NULL
                              CONSTRAINT FK_lms_AnswerReviewRequest_Tenant REFERENCES lms.Tenant(TenantId),
        AttemptId         UNIQUEIDENTIFIER NOT NULL,
        QuestionId        UNIQUEIDENTIFIER NOT NULL,
        RequestedBy       NVARCHAR(320)    NOT NULL,
        Note              NVARCHAR(500)    NULL,
        RequestedAt       DATETIME2(3)     NOT NULL
                              CONSTRAINT DF_lms_AnswerReviewRequest_RequestedAt DEFAULT (SYSUTCDATETIME()),
        ResolvedByGradeId UNIQUEIDENTIFIER NULL
                              CONSTRAINT FK_lms_AnswerReviewRequest_Grade REFERENCES lms.AnswerGrade(GradeId),
        CONSTRAINT FK_lms_AnswerReviewRequest_Response
            FOREIGN KEY (AttemptId, QuestionId) REFERENCES lms.AnswerResponse (AttemptId, QuestionId) ON DELETE CASCADE,
        CONSTRAINT UQ_lms_AnswerReviewRequest_Answer UNIQUE (TenantId, AttemptId, QuestionId)
    );
GO
