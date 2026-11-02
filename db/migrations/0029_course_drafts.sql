-- 0029_course_drafts: lms.CourseDraft, the course builder's working copy
-- (docs/plans/2026-10-28-course-builder-mvp.md). One draft per course, held
-- as one JSON document. Publishing turns it into a new lms.CourseVersion and
-- deletes it, so published lessons, blocks and quizzes are never edited.
-- DraftId tells one draft of a course from the next: Revision restarts at 1
-- for every new draft, so a revision alone can't say which draft it was.

IF NOT EXISTS (SELECT 1 FROM sys.indexes
                WHERE name = 'UQ_lms_Course_TenantCourse'
                  AND object_id = OBJECT_ID('lms.Course'))
    CREATE UNIQUE INDEX UQ_lms_Course_TenantCourse ON lms.Course (TenantId, CourseId);
GO

IF OBJECT_ID('lms.CourseDraft', 'U') IS NULL
    CREATE TABLE lms.CourseDraft (
        CourseId      UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_CourseDraft PRIMARY KEY,
        DraftId       UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_lms_CourseDraft_DraftId DEFAULT (NEWID()),
        TenantId      UNIQUEIDENTIFIER NOT NULL,
        BaseVersionId UNIQUEIDENTIFIER NULL
                          CONSTRAINT FK_lms_CourseDraft_BaseVersion REFERENCES lms.CourseVersion(VersionId),
        DocJson       NVARCHAR(MAX)    NOT NULL
                          CONSTRAINT CK_lms_CourseDraft_DocJson CHECK (ISJSON(DocJson) = 1),
        Revision      INT              NOT NULL CONSTRAINT DF_lms_CourseDraft_Revision DEFAULT (1),
        CreatedBy     NVARCHAR(256)    NOT NULL,
        CreatedAt     DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_CourseDraft_Created DEFAULT (SYSUTCDATETIME()),
        UpdatedBy     NVARCHAR(256)    NOT NULL,
        UpdatedAt     DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_CourseDraft_Updated DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT FK_lms_CourseDraft_Course
            FOREIGN KEY (TenantId, CourseId) REFERENCES lms.Course (TenantId, CourseId)
    );
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
                WHERE name = 'IX_lms_CourseDraft_TenantUpdated'
                  AND object_id = OBJECT_ID('lms.CourseDraft'))
    CREATE INDEX IX_lms_CourseDraft_TenantUpdated
        ON lms.CourseDraft (TenantId, UpdatedAt DESC);
GO
