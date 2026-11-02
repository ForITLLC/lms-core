-- forit-LMS — migration 0011: course owning instructor or group.
-- A course can be attributed to an owner — either an AppUser (an instructor)
-- or an AAD security group. v1 is display + filtering only; no edit-lock.
-- Owner lives on lms.Course, not CourseVersion — it is versionless metadata,
-- unchanged when a course is republished.
-- Idempotent: IF NOT EXISTS column guards, matching 0008 / 0010 style.

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('lms.Course') AND name = 'OwnerUserId'
)
    ALTER TABLE lms.Course ADD OwnerUserId UNIQUEIDENTIFIER NULL
        CONSTRAINT FK_lms_Course_OwnerUser REFERENCES lms.AppUser(AppUserId);
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('lms.Course') AND name = 'OwnerGroupId'
)
    ALTER TABLE lms.Course ADD OwnerGroupId NVARCHAR(64) NULL;
GO

-- AAD group ids are opaque GUIDs; cache the display label so the UI need not
-- round-trip Graph to render an owner chip.
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('lms.Course') AND name = 'OwnerGroupName'
)
    ALTER TABLE lms.Course ADD OwnerGroupName NVARCHAR(256) NULL;
GO

-- A course is owned by a person OR a group, never both.
IF NOT EXISTS (
    SELECT 1 FROM sys.check_constraints
     WHERE name = 'CK_lms_Course_OwnerExclusive'
)
    ALTER TABLE lms.Course ADD CONSTRAINT CK_lms_Course_OwnerExclusive
        CHECK (OwnerUserId IS NULL OR OwnerGroupId IS NULL);
GO
