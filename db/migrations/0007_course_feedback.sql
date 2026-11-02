-- forit-LMS — course feedback (1-5 star rating + optional comment per learner per course).
-- Idempotent: re-runnable. Match the IF NOT EXISTS guard style of 0006.

IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
     WHERE s.name = 'lms' AND t.name = 'CourseFeedback'
)
BEGIN
    CREATE TABLE lms.CourseFeedback (
        FeedbackId  UNIQUEIDENTIFIER NOT NULL
                       CONSTRAINT DF_lms_CourseFeedback_Id DEFAULT (NEWID())
                       CONSTRAINT PK_lms_CourseFeedback PRIMARY KEY,
        TenantId    UNIQUEIDENTIFIER NOT NULL
                       CONSTRAINT FK_lms_CourseFeedback_Tenant REFERENCES lms.Tenant(TenantId),
        LearnerId   UNIQUEIDENTIFIER NOT NULL
                       CONSTRAINT FK_lms_CourseFeedback_Learner REFERENCES lms.Learner(LearnerId),
        CourseId    UNIQUEIDENTIFIER NOT NULL
                       CONSTRAINT FK_lms_CourseFeedback_Course REFERENCES lms.Course(CourseId),
        Rating      TINYINT          NOT NULL
                       CONSTRAINT CK_lms_CourseFeedback_Rating CHECK (Rating BETWEEN 1 AND 5),
        Comment     NVARCHAR(MAX)    NULL,
        SubmittedAt DATETIME2(3)     NOT NULL
                       CONSTRAINT DF_lms_CourseFeedback_Submitted DEFAULT (SYSUTCDATETIME()),
        UpdatedAt   DATETIME2(3)     NOT NULL
                       CONSTRAINT DF_lms_CourseFeedback_Updated DEFAULT (SYSUTCDATETIME())
    );
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'UQ_CourseFeedback_Tenant_Learner_Course'
       AND object_id = OBJECT_ID('lms.CourseFeedback')
)
BEGIN
    CREATE UNIQUE INDEX UQ_CourseFeedback_Tenant_Learner_Course
        ON lms.CourseFeedback (TenantId, LearnerId, CourseId);
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_CourseFeedback_Tenant_Course'
       AND object_id = OBJECT_ID('lms.CourseFeedback')
)
BEGIN
    CREATE INDEX IX_CourseFeedback_Tenant_Course
        ON lms.CourseFeedback (TenantId, CourseId);
END
GO
