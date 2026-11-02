-- forit-LMS — migration 0014: shared ForIT course catalogue.
-- A course owned by the canonical 'forit' tenant can be flagged IsCatalog=1
-- to publish it into a shared catalogue. Any other tenant subscribes to
-- individual catalogue courses via lms.CatalogSubscription; subscribed
-- courses then surface in that tenant's /learn and dashboard, read-only.
--
-- This is the LMS's one sanctioned cross-tenant read: a subscriber's learners
-- read course *content* owned by the forit tenant, but all learner data
-- (Learner / Enrollment / Progress / QuizAttempt) stays keyed to the
-- subscriber's own tenant. The publish API enforces that IsCatalog is only
-- ever set on forit-tenant courses.
-- Idempotent: IF NOT EXISTS column guard + IF OBJECT_ID table guard.

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('lms.Course') AND name = 'IsCatalog'
)
    ALTER TABLE lms.Course ADD IsCatalog BIT NOT NULL
        CONSTRAINT DF_lms_Course_IsCatalog DEFAULT (0);
GO

IF OBJECT_ID('lms.CatalogSubscription', 'U') IS NULL
CREATE TABLE lms.CatalogSubscription (
    TenantId  UNIQUEIDENTIFIER NOT NULL
                 CONSTRAINT FK_lms_CatalogSub_Tenant REFERENCES lms.Tenant(TenantId),
    CourseId  UNIQUEIDENTIFIER NOT NULL
                 CONSTRAINT FK_lms_CatalogSub_Course REFERENCES lms.Course(CourseId),
    AddedBy   NVARCHAR(256)    NOT NULL,
    AddedAt   DATETIME2(3)     NOT NULL
                 CONSTRAINT DF_lms_CatalogSub_Added DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_lms_CatalogSubscription PRIMARY KEY (TenantId, CourseId)
);
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_lms_CatalogSub_Course'
       AND object_id = OBJECT_ID('lms.CatalogSubscription')
)
CREATE INDEX IX_lms_CatalogSub_Course ON lms.CatalogSubscription (CourseId);
GO
