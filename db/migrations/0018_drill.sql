-- forit-LMS — migration 0018: Anti-Brain-Rot daily drill.
-- Five tables: a tenant-scoped reasoning item bank, per-learner FSRS cards
-- over existing lms.QuizQuestion rows, one session per learner per local
-- date, one review per answered slot, and a per-learner stats row (streak,
-- freezes, points, calibration counters). Every table carries TenantId so
-- each query stays tenant-scoped. Idempotent: OBJECT_ID / sys.indexes guards.

IF OBJECT_ID('lms.DrillItem', 'U') IS NULL
CREATE TABLE lms.DrillItem (
    DrillItemId  UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_DrillItem PRIMARY KEY,
    TenantId     UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_DrillItem_Tenant REFERENCES lms.Tenant(TenantId),
    Kind         NVARCHAR(32)     NOT NULL CONSTRAINT DF_lms_DrillItem_Kind DEFAULT ('reasoning'),
    Category     NVARCHAR(32)     NOT NULL,
    Difficulty   TINYINT          NOT NULL CONSTRAINT DF_lms_DrillItem_Difficulty DEFAULT (3),
    PayloadJson  NVARCHAR(MAX)    NOT NULL,
    Source       NVARCHAR(32)     NOT NULL CONSTRAINT DF_lms_DrillItem_Source DEFAULT ('ai'),
    IsActive     BIT              NOT NULL CONSTRAINT DF_lms_DrillItem_Active DEFAULT (1),
    CreatedAt    DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_DrillItem_Created DEFAULT (SYSUTCDATETIME())
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_lms_DrillItem_TenantActive'
                 AND object_id = OBJECT_ID('lms.DrillItem'))
    CREATE INDEX IX_lms_DrillItem_TenantActive ON lms.DrillItem (TenantId, IsActive);
GO

IF OBJECT_ID('lms.DrillCard', 'U') IS NULL
CREATE TABLE lms.DrillCard (
    CardId      UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_DrillCard PRIMARY KEY,
    TenantId    UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_DrillCard_Tenant REFERENCES lms.Tenant(TenantId),
    LearnerId   UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_DrillCard_Learner REFERENCES lms.Learner(LearnerId),
    QuestionId  UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_DrillCard_Question REFERENCES lms.QuizQuestion(QuestionId) ON DELETE CASCADE,
    FsrsJson    NVARCHAR(MAX)    NOT NULL,
    Due         DATETIME2(3)     NOT NULL,
    State       TINYINT          NOT NULL CONSTRAINT DF_lms_DrillCard_State DEFAULT (0),
    Reps        INT              NOT NULL CONSTRAINT DF_lms_DrillCard_Reps DEFAULT (0),
    Lapses      INT              NOT NULL CONSTRAINT DF_lms_DrillCard_Lapses DEFAULT (0),
    LastReview  DATETIME2(3)     NULL,
    CreatedAt   DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_DrillCard_Created DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_lms_DrillCard_LearnerQuestion UNIQUE (LearnerId, QuestionId)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_lms_DrillCard_LearnerDue'
                 AND object_id = OBJECT_ID('lms.DrillCard'))
    CREATE INDEX IX_lms_DrillCard_LearnerDue ON lms.DrillCard (LearnerId, Due);
GO

IF OBJECT_ID('lms.DrillSession', 'U') IS NULL
CREATE TABLE lms.DrillSession (
    SessionId     UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_DrillSession PRIMARY KEY,
    TenantId      UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_DrillSession_Tenant REFERENCES lms.Tenant(TenantId),
    LearnerId     UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_DrillSession_Learner REFERENCES lms.Learner(LearnerId),
    LocalDate     DATE             NOT NULL,
    TimeZone      NVARCHAR(64)     NOT NULL,
    ItemsJson     NVARCHAR(MAX)    NOT NULL,
    StartedAt     DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_DrillSession_Started DEFAULT (SYSUTCDATETIME()),
    CompletedAt   DATETIME2(3)     NULL,
    Points        INT              NOT NULL CONSTRAINT DF_lms_DrillSession_Points DEFAULT (0),
    CorrectCount  INT              NOT NULL CONSTRAINT DF_lms_DrillSession_Correct DEFAULT (0),
    TotalCount    INT              NOT NULL,
    CONSTRAINT UQ_lms_DrillSession_LearnerDate UNIQUE (LearnerId, LocalDate)
);
GO

IF OBJECT_ID('lms.DrillReview', 'U') IS NULL
CREATE TABLE lms.DrillReview (
    ReviewId     UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_DrillReview PRIMARY KEY,
    SessionId    UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_DrillReview_Session REFERENCES lms.DrillSession(SessionId) ON DELETE CASCADE,
    TenantId     UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_DrillReview_Tenant REFERENCES lms.Tenant(TenantId),
    LearnerId    UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_DrillReview_Learner REFERENCES lms.Learner(LearnerId),
    Slot         INT              NOT NULL,
    CardId       UNIQUEIDENTIFIER NULL,
    QuestionId   UNIQUEIDENTIFIER NULL,
    DrillItemId  UNIQUEIDENTIFIER NULL,
    ResponseJson NVARCHAR(MAX)    NOT NULL,
    Correct      BIT              NOT NULL,
    Confidence   TINYINT          NOT NULL,
    Rating       TINYINT          NOT NULL,
    ResponseMs   INT              NOT NULL CONSTRAINT DF_lms_DrillReview_ResponseMs DEFAULT (0),
    Points       INT              NOT NULL CONSTRAINT DF_lms_DrillReview_Points DEFAULT (0),
    AnsweredAt   DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_DrillReview_Answered DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_lms_DrillReview_SessionSlot UNIQUE (SessionId, Slot)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_lms_DrillReview_LearnerItem'
                 AND object_id = OBJECT_ID('lms.DrillReview'))
    CREATE INDEX IX_lms_DrillReview_LearnerItem ON lms.DrillReview (LearnerId, DrillItemId);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_lms_DrillReview_LearnerAnswered'
                 AND object_id = OBJECT_ID('lms.DrillReview'))
    CREATE INDEX IX_lms_DrillReview_LearnerAnswered ON lms.DrillReview (LearnerId, AnsweredAt) INCLUDE (Correct, Confidence);
GO

IF OBJECT_ID('lms.DrillLearnerStats', 'U') IS NULL
CREATE TABLE lms.DrillLearnerStats (
    LearnerId               UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_DrillLearnerStats PRIMARY KEY
                                CONSTRAINT FK_lms_DrillStats_Learner REFERENCES lms.Learner(LearnerId),
    TenantId                UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_DrillStats_Tenant REFERENCES lms.Tenant(TenantId),
    CurrentStreak           INT     NOT NULL CONSTRAINT DF_lms_DrillStats_Streak DEFAULT (0),
    LongestStreak           INT     NOT NULL CONSTRAINT DF_lms_DrillStats_Longest DEFAULT (0),
    LastCompletedLocalDate  DATE    NULL,
    FreezesAvailable        TINYINT NOT NULL CONSTRAINT DF_lms_DrillStats_Freezes DEFAULT (1),
    TotalPoints             INT     NOT NULL CONSTRAINT DF_lms_DrillStats_Points DEFAULT (0),
    SessionsCompleted       INT     NOT NULL CONSTRAINT DF_lms_DrillStats_Sessions DEFAULT (0),
    TotalAnswered           INT     NOT NULL CONSTRAINT DF_lms_DrillStats_Answered DEFAULT (0),
    TotalCorrect            INT     NOT NULL CONSTRAINT DF_lms_DrillStats_Correct DEFAULT (0),
    CertainAnswered         INT     NOT NULL CONSTRAINT DF_lms_DrillStats_CertainAnswered DEFAULT (0),
    CertainCorrect          INT     NOT NULL CONSTRAINT DF_lms_DrillStats_CertainCorrect DEFAULT (0),
    UpdatedAt               DATETIME2(3) NOT NULL CONSTRAINT DF_lms_DrillStats_Updated DEFAULT (SYSUTCDATETIME())
);
GO
