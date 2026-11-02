-- forit-LMS — course versioning + manual assignment.
-- Hybrid versioned-relational-rows model: every Lesson/Block/Quiz/QuizQuestion
-- row carries a VersionId; "publishing" creates a new CourseVersion row plus a
-- fresh set of content rows, never deletes the old ones. Enrollment +
-- CourseAssignment pin a VersionId so in-flight learners stay on the version
-- they started. See docs/plans/2026-05-18-course-versioning-and-assignment-design.md.
--
-- Idempotent: re-runnable, matches the IF NOT EXISTS guard style of 0006 / 0007.

------------------------------------------------------------
-- 1. lms.CourseVersion table
------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
     WHERE s.name = 'lms' AND t.name = 'CourseVersion'
)
BEGIN
    CREATE TABLE lms.CourseVersion (
        VersionId     UNIQUEIDENTIFIER NOT NULL
                          CONSTRAINT DF_lms_CourseVersion_Id DEFAULT (NEWID())
                          CONSTRAINT PK_lms_CourseVersion PRIMARY KEY,
        CourseId      UNIQUEIDENTIFIER NOT NULL
                          CONSTRAINT FK_lms_CourseVersion_Course REFERENCES lms.Course(CourseId),
        VersionNumber INT              NOT NULL,
        PublishedAt   DATETIME2(3)     NOT NULL
                          CONSTRAINT DF_lms_CourseVersion_Published DEFAULT (SYSUTCDATETIME()),
        PublishedBy   NVARCHAR(256)    NOT NULL,
        ChangeNote    NVARCHAR(1024)   NULL,
        CONSTRAINT UQ_lms_CourseVersion_Course_Num UNIQUE (CourseId, VersionNumber)
    );
END
GO

------------------------------------------------------------
-- 2. Course.CurrentVersionId pointer
------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('lms.Course') AND name = 'CurrentVersionId'
)
BEGIN
    ALTER TABLE lms.Course
        ADD CurrentVersionId UNIQUEIDENTIFIER NULL
            CONSTRAINT FK_lms_Course_CurrentVersion REFERENCES lms.CourseVersion(VersionId);
END
GO

------------------------------------------------------------
-- 3. VersionId columns on content tables (nullable for backfill)
------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('lms.Lesson') AND name = 'VersionId'
)
BEGIN
    ALTER TABLE lms.Lesson
        ADD VersionId UNIQUEIDENTIFIER NULL
            CONSTRAINT FK_lms_Lesson_Version REFERENCES lms.CourseVersion(VersionId);
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('lms.Block') AND name = 'VersionId'
)
BEGIN
    ALTER TABLE lms.Block
        ADD VersionId UNIQUEIDENTIFIER NULL
            CONSTRAINT FK_lms_Block_Version REFERENCES lms.CourseVersion(VersionId);
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('lms.Quiz') AND name = 'VersionId'
)
BEGIN
    ALTER TABLE lms.Quiz
        ADD VersionId UNIQUEIDENTIFIER NULL
            CONSTRAINT FK_lms_Quiz_Version REFERENCES lms.CourseVersion(VersionId);
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('lms.QuizQuestion') AND name = 'VersionId'
)
BEGIN
    ALTER TABLE lms.QuizQuestion
        ADD VersionId UNIQUEIDENTIFIER NULL
            CONSTRAINT FK_lms_QuizQ_Version REFERENCES lms.CourseVersion(VersionId);
END
GO

------------------------------------------------------------
-- 4. Backfill: every existing course → v1, every existing content row tagged
------------------------------------------------------------
-- Create v1 for any course that doesn't yet have any CourseVersion rows.
INSERT INTO lms.CourseVersion (VersionId, CourseId, VersionNumber, PublishedBy, ChangeNote)
SELECT NEWID(), c.CourseId, 1, 'system:migration-0008', 'Backfilled from initial schema'
  FROM lms.Course c
 WHERE NOT EXISTS (
     SELECT 1 FROM lms.CourseVersion v WHERE v.CourseId = c.CourseId
 );
GO

-- Tag every Lesson with its course's v1 VersionId (only where still NULL).
UPDATE l
   SET l.VersionId = v.VersionId
  FROM lms.Lesson l
  JOIN lms.CourseVersion v
    ON v.CourseId = l.CourseId AND v.VersionNumber = 1
 WHERE l.VersionId IS NULL;
GO

-- Tag every Block with the same VersionId as its parent Lesson.
UPDATE b
   SET b.VersionId = l.VersionId
  FROM lms.Block b
  JOIN lms.Lesson l ON l.LessonId = b.LessonId
 WHERE b.VersionId IS NULL;
GO

-- Tag every Quiz with the same VersionId as its parent Block.
UPDATE q
   SET q.VersionId = b.VersionId
  FROM lms.Quiz q
  JOIN lms.Block b ON b.BlockId = q.BlockId
 WHERE q.VersionId IS NULL;
GO

-- Tag every QuizQuestion with the same VersionId as its parent Quiz.
UPDATE qq
   SET qq.VersionId = q.VersionId
  FROM lms.QuizQuestion qq
  JOIN lms.Quiz q ON q.QuizId = qq.QuizId
 WHERE qq.VersionId IS NULL;
GO

-- Point every Course at its v1 (only where still NULL).
UPDATE c
   SET c.CurrentVersionId = v.VersionId
  FROM lms.Course c
  JOIN lms.CourseVersion v
    ON v.CourseId = c.CourseId AND v.VersionNumber = 1
 WHERE c.CurrentVersionId IS NULL;
GO

------------------------------------------------------------
-- 5. Promote VersionId columns to NOT NULL once backfill is in
------------------------------------------------------------
IF EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('lms.Lesson') AND name = 'VersionId' AND is_nullable = 1
)
BEGIN
    ALTER TABLE lms.Lesson ALTER COLUMN VersionId UNIQUEIDENTIFIER NOT NULL;
END
GO

IF EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('lms.Block') AND name = 'VersionId' AND is_nullable = 1
)
BEGIN
    ALTER TABLE lms.Block ALTER COLUMN VersionId UNIQUEIDENTIFIER NOT NULL;
END
GO

IF EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('lms.Quiz') AND name = 'VersionId' AND is_nullable = 1
)
BEGIN
    ALTER TABLE lms.Quiz ALTER COLUMN VersionId UNIQUEIDENTIFIER NOT NULL;
END
GO

IF EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('lms.QuizQuestion') AND name = 'VersionId' AND is_nullable = 1
)
BEGIN
    ALTER TABLE lms.QuizQuestion ALTER COLUMN VersionId UNIQUEIDENTIFIER NOT NULL;
END
GO

------------------------------------------------------------
-- 6. Drop the (CourseId, OrderIndex) uniqueness so multiple versions of the
--    same course can coexist with the same OrderIndex per lesson; replace it
--    with (CourseId, VersionId, OrderIndex). Block/QuizQuestion uniqueness
--    keys off LessonId/QuizId which get fresh UUIDs per version, so they
--    don't need touching.
------------------------------------------------------------
IF EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'UQ_lms_Lesson_CourseOrder' AND object_id = OBJECT_ID('lms.Lesson')
)
BEGIN
    ALTER TABLE lms.Lesson DROP CONSTRAINT UQ_lms_Lesson_CourseOrder;
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'UQ_lms_Lesson_CourseVersionOrder' AND object_id = OBJECT_ID('lms.Lesson')
)
BEGIN
    ALTER TABLE lms.Lesson ADD CONSTRAINT UQ_lms_Lesson_CourseVersionOrder
        UNIQUE (CourseId, VersionId, OrderIndex);
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_lms_Lesson_Version' AND object_id = OBJECT_ID('lms.Lesson')
)
BEGIN
    CREATE INDEX IX_lms_Lesson_Version ON lms.Lesson (CourseId, VersionId, OrderIndex);
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_lms_Block_Version' AND object_id = OBJECT_ID('lms.Block')
)
BEGIN
    CREATE INDEX IX_lms_Block_Version ON lms.Block (VersionId, LessonId, OrderIndex);
END
GO

------------------------------------------------------------
-- 7. Enrollment.VersionId (pin learner to a version at enroll time)
------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('lms.Enrollment') AND name = 'VersionId'
)
BEGIN
    ALTER TABLE lms.Enrollment
        ADD VersionId UNIQUEIDENTIFIER NULL
            CONSTRAINT FK_lms_Enrollment_Version REFERENCES lms.CourseVersion(VersionId);
END
GO

-- Backfill: any Enrollment without a pinned version → its course's v1.
UPDATE e
   SET e.VersionId = v.VersionId
  FROM lms.Enrollment e
  JOIN lms.CourseVersion v
    ON v.CourseId = e.CourseId AND v.VersionNumber = 1
 WHERE e.VersionId IS NULL;
GO

IF EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('lms.Enrollment') AND name = 'VersionId' AND is_nullable = 1
)
BEGIN
    ALTER TABLE lms.Enrollment ALTER COLUMN VersionId UNIQUEIDENTIFIER NOT NULL;
END
GO

------------------------------------------------------------
-- 8. lms.CourseAssignment — admin-driven manual assignment
------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
     WHERE s.name = 'lms' AND t.name = 'CourseAssignment'
)
BEGIN
    CREATE TABLE lms.CourseAssignment (
        AssignmentId UNIQUEIDENTIFIER NOT NULL
                         CONSTRAINT DF_lms_CourseAssignment_Id DEFAULT (NEWID())
                         CONSTRAINT PK_lms_CourseAssignment PRIMARY KEY,
        TenantId     UNIQUEIDENTIFIER NOT NULL
                         CONSTRAINT FK_lms_CourseAssignment_Tenant REFERENCES lms.Tenant(TenantId),
        LearnerId    UNIQUEIDENTIFIER NOT NULL
                         CONSTRAINT FK_lms_CourseAssignment_Learner REFERENCES lms.Learner(LearnerId),
        CourseId     UNIQUEIDENTIFIER NOT NULL
                         CONSTRAINT FK_lms_CourseAssignment_Course REFERENCES lms.Course(CourseId),
        VersionId    UNIQUEIDENTIFIER NOT NULL
                         CONSTRAINT FK_lms_CourseAssignment_Version REFERENCES lms.CourseVersion(VersionId),
        AssignedBy   NVARCHAR(256)    NOT NULL,
        AssignedAt   DATETIME2(3)     NOT NULL
                         CONSTRAINT DF_lms_CourseAssignment_Assigned DEFAULT (SYSUTCDATETIME()),
        DueDate      DATETIME2(3)     NULL,
        Note         NVARCHAR(1024)   NULL,
        Status       NVARCHAR(32)     NOT NULL
                         CONSTRAINT DF_lms_CourseAssignment_Status DEFAULT ('active'),
        CONSTRAINT UQ_lms_CourseAssignment_Tenant_Learner_Course
            UNIQUE (TenantId, LearnerId, CourseId)
    );
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_lms_CourseAssignment_Tenant_Course'
       AND object_id = OBJECT_ID('lms.CourseAssignment')
)
BEGIN
    CREATE INDEX IX_lms_CourseAssignment_Tenant_Course
        ON lms.CourseAssignment (TenantId, CourseId, Status);
END
GO
