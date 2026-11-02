-- 0032_answer_grades: marks for short written answers, the AI marking queue
-- and the per-tenant switch for it (docs/plans/2026-10-29-ai-authoring.md,
-- slice A5a).
-- lms.AnswerGrade is append-only: every mark an answer gets, from the AI or
-- an instructor, is a new row, and the latest instructor row wins. Seq counts
-- an attempt's marks from 1, so "latest" never rests on two clocks agreeing,
-- and two writers that read the same marks can't both append. An
-- instructor row that names the AI row it agrees with (ConfirmsGradeId) is a
-- confirmation; any other instructor row is an override and must give a
-- reason.
-- lms.AnswerGradingJob is its own queue rather than more rows in
-- lms.AssetIngestion, whose per-tenant caps, listings and course stamping
-- would all count grading jobs as course drafts.
-- lms.TenantAiSetting holds the tenant admin's choice and who made it, which
-- lms.Tenant.AISettingsJson (unread since 0001) has no place for. No row
-- reads as off, so every tenant starts off with nothing to backfill.

IF OBJECT_ID('lms.AnswerGrade', 'U') IS NULL
    CREATE TABLE lms.AnswerGrade (
        GradeId         UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_AnswerGrade PRIMARY KEY,
        TenantId        UNIQUEIDENTIFIER NOT NULL
                            CONSTRAINT FK_lms_AnswerGrade_Tenant REFERENCES lms.Tenant(TenantId),
        AttemptId       UNIQUEIDENTIFIER NOT NULL,
        QuestionId      UNIQUEIDENTIFIER NOT NULL,
        Seq             INT              NOT NULL,
        Source          NVARCHAR(16)     NOT NULL
                            CONSTRAINT CK_lms_AnswerGrade_Source CHECK (Source IN ('ai', 'instructor')),
        Score           INT              NOT NULL,
        MaxScore        INT              NOT NULL,
        FeedbackMd      NVARCHAR(MAX)    NULL,
        Model           NVARCHAR(64)     NULL,
        PromptVersion   NVARCHAR(32)     NULL,
        GradedBy        NVARCHAR(256)    NULL,
        GradedAt        DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_AnswerGrade_GradedAt DEFAULT (SYSUTCDATETIME()),
        Reason          NVARCHAR(1000)   NULL,
        ConfirmsGradeId UNIQUEIDENTIFIER NULL
                            CONSTRAINT FK_lms_AnswerGrade_Confirms REFERENCES lms.AnswerGrade(GradeId),
        CONSTRAINT FK_lms_AnswerGrade_Response
            FOREIGN KEY (AttemptId, QuestionId) REFERENCES lms.AnswerResponse (AttemptId, QuestionId) ON DELETE CASCADE,
        CONSTRAINT CK_lms_AnswerGrade_Score CHECK (MaxScore > 0 AND Score >= 0 AND Score <= MaxScore),
        CONSTRAINT CK_lms_AnswerGrade_Who CHECK (
            (Source = 'ai' AND Model IS NOT NULL AND PromptVersion IS NOT NULL
                AND GradedBy IS NULL AND Reason IS NULL AND ConfirmsGradeId IS NULL)
            OR (Source = 'instructor' AND GradedBy IS NOT NULL AND Model IS NULL AND PromptVersion IS NULL)),
        CONSTRAINT CK_lms_AnswerGrade_Reason CHECK (
            Source = 'ai' OR ConfirmsGradeId IS NOT NULL
            OR (Reason IS NOT NULL AND LEN(LTRIM(RTRIM(Reason))) > 0))
    );
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
                WHERE name = 'UX_lms_AnswerGrade_TenantAttemptSeq'
                  AND object_id = OBJECT_ID('lms.AnswerGrade'))
    CREATE UNIQUE INDEX UX_lms_AnswerGrade_TenantAttemptSeq
        ON lms.AnswerGrade (TenantId, AttemptId, Seq);
GO

IF OBJECT_ID('lms.AnswerGradingJob', 'U') IS NULL
    CREATE TABLE lms.AnswerGradingJob (
        JobId         UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_AnswerGradingJob PRIMARY KEY,
        TenantId      UNIQUEIDENTIFIER NOT NULL
                          CONSTRAINT FK_lms_AnswerGradingJob_Tenant REFERENCES lms.Tenant(TenantId),
        AttemptId     UNIQUEIDENTIFIER NOT NULL,
        QuestionId    UNIQUEIDENTIFIER NOT NULL,
        Status        NVARCHAR(16)     NOT NULL CONSTRAINT DF_lms_AnswerGradingJob_Status DEFAULT ('queued')
                          CONSTRAINT CK_lms_AnswerGradingJob_Status
                              CHECK (Status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        Attempts      INT              NOT NULL CONSTRAINT DF_lms_AnswerGradingJob_Attempts DEFAULT (0),
        NotBefore     DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_AnswerGradingJob_NotBefore DEFAULT (SYSUTCDATETIME()),
        LeaseUntil    DATETIME2(3)     NULL,
        LeaseToken    UNIQUEIDENTIFIER NULL,
        ErrorMessage  NVARCHAR(4000)   NULL,
        UsageJson     NVARCHAR(MAX)    NULL
                          CONSTRAINT CK_lms_AnswerGradingJob_UsageJson CHECK (UsageJson IS NULL OR ISJSON(UsageJson) = 1),
        ResultGradeId UNIQUEIDENTIFIER NULL
                          CONSTRAINT FK_lms_AnswerGradingJob_Grade REFERENCES lms.AnswerGrade(GradeId),
        CreatedAt     DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_AnswerGradingJob_Created DEFAULT (SYSUTCDATETIME()),
        UpdatedAt     DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_AnswerGradingJob_Updated DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT FK_lms_AnswerGradingJob_Response
            FOREIGN KEY (AttemptId, QuestionId) REFERENCES lms.AnswerResponse (AttemptId, QuestionId) ON DELETE CASCADE,
        CONSTRAINT UQ_lms_AnswerGradingJob_Answer UNIQUE (TenantId, AttemptId, QuestionId)
    );
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
                WHERE name = 'IX_lms_AnswerGradingJob_StatusNotBefore'
                  AND object_id = OBJECT_ID('lms.AnswerGradingJob'))
    CREATE INDEX IX_lms_AnswerGradingJob_StatusNotBefore
        ON lms.AnswerGradingJob (Status, NotBefore);
GO

IF OBJECT_ID('lms.TenantAiSetting', 'U') IS NULL
    CREATE TABLE lms.TenantAiSetting (
        TenantId            UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_TenantAiSetting PRIMARY KEY
                                CONSTRAINT FK_lms_TenantAiSetting_Tenant REFERENCES lms.Tenant(TenantId),
        GradeWrittenAnswers BIT              NOT NULL CONSTRAINT DF_lms_TenantAiSetting_Grade DEFAULT (0),
        UpdatedBy           NVARCHAR(256)    NOT NULL,
        UpdatedAt           DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_TenantAiSetting_Updated DEFAULT (SYSUTCDATETIME())
    );
GO
