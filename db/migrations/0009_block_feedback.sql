-- forit-LMS — per-block (per-slide) feedback. A learner leaves a free-text note
-- scoped to a single content block while moving through a course. Distinct from
-- lms.CourseFeedback (one whole-course 1-5 star rating, migration 0007).
-- One row per (TenantId, LearnerId, BlockId); upsert edits the note in place.
-- Idempotent: re-runnable. Matches the IF NOT EXISTS guard style of 0007 / 0008.

IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
     WHERE s.name = 'lms' AND t.name = 'BlockFeedback'
)
BEGIN
    CREATE TABLE lms.BlockFeedback (
        BlockFeedbackId UNIQUEIDENTIFIER NOT NULL
                           CONSTRAINT DF_lms_BlockFeedback_Id DEFAULT (NEWID())
                           CONSTRAINT PK_lms_BlockFeedback PRIMARY KEY,
        TenantId        UNIQUEIDENTIFIER NOT NULL
                           CONSTRAINT FK_lms_BlockFeedback_Tenant REFERENCES lms.Tenant(TenantId),
        LearnerId       UNIQUEIDENTIFIER NOT NULL
                           CONSTRAINT FK_lms_BlockFeedback_Learner REFERENCES lms.Learner(LearnerId),
        CourseId        UNIQUEIDENTIFIER NOT NULL
                           CONSTRAINT FK_lms_BlockFeedback_Course REFERENCES lms.Course(CourseId),
        BlockId         UNIQUEIDENTIFIER NOT NULL
                           CONSTRAINT FK_lms_BlockFeedback_Block REFERENCES lms.Block(BlockId),
        Comment         NVARCHAR(MAX)    NOT NULL,
        Resolved        BIT              NOT NULL
                           CONSTRAINT DF_lms_BlockFeedback_Resolved DEFAULT (0),
        CreatedAt       DATETIME2(3)     NOT NULL
                           CONSTRAINT DF_lms_BlockFeedback_Created DEFAULT (SYSUTCDATETIME()),
        UpdatedAt       DATETIME2(3)     NOT NULL
                           CONSTRAINT DF_lms_BlockFeedback_Updated DEFAULT (SYSUTCDATETIME())
    );
END
GO

-- One revisable note per learner per slide.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'UQ_BlockFeedback_Tenant_Learner_Block'
       AND object_id = OBJECT_ID('lms.BlockFeedback')
)
BEGIN
    CREATE UNIQUE INDEX UQ_BlockFeedback_Tenant_Learner_Block
        ON lms.BlockFeedback (TenantId, LearnerId, BlockId);
END
GO

-- Author inbox: all per-slide feedback for a course, filterable by Resolved.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_BlockFeedback_Tenant_Course'
       AND object_id = OBJECT_ID('lms.BlockFeedback')
)
BEGIN
    CREATE INDEX IX_BlockFeedback_Tenant_Course
        ON lms.BlockFeedback (TenantId, CourseId, Resolved);
END
GO
