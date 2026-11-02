-- forit-LMS — migration 0003: course recurrence + HR-group-driven training/admin
-- Target: shared `forit` Azure SQL DB, lms.* schema. Run as foritadmin.
-- Idempotent — every statement is guarded so re-runs are safe.

-- RecurrenceMonths on lms.Course. NULL = evergreen (no expiry); a positive
-- value drives lms.Certificate.ExpiresAt = IssuedAt + RecurrenceMonths so the
-- learner is prompted to re-complete the course before the cert lapses.
-- Annual security-awareness training = 12.
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID('lms.Course') AND name = 'RecurrenceMonths')
    ALTER TABLE lms.Course ADD RecurrenceMonths INT NULL;
GO

-- AAD security group whose members get LMS admin role at sign-in.
-- Per-tenant so non-HR-tenants can bind their own admin group, or leave NULL
-- to keep the existing default-author behavior.
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID('lms.Tenant') AND name = 'HrAdminAdGroupId')
    ALTER TABLE lms.Tenant ADD HrAdminAdGroupId NVARCHAR(64) NULL;
GO

-- Curriculum-to-AAD-group binding. A learner whose AAD group memberships
-- intersect with the bindings for a curriculum gets that curriculum's courses
-- added to their required training. Multiple groups can map to the same
-- curriculum (HR + Compliance both required to take privacy training); a
-- single group can map to multiple curricula. NULL group on the default
-- curriculum is implicit: every authenticated learner already gets the
-- tenant's default curriculum, this table layers ADDITIONAL bindings.
IF OBJECT_ID('lms.CurriculumGroup', 'U') IS NULL
CREATE TABLE lms.CurriculumGroup (
    CurriculumId UNIQUEIDENTIFIER NOT NULL
        CONSTRAINT FK_lms_CurriculumGroup_Curriculum REFERENCES lms.Curriculum(CurriculumId) ON DELETE CASCADE,
    AdGroupId    NVARCHAR(64)     NOT NULL,
    CreatedAt    DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_CurriculumGroup_Created DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_lms_CurriculumGroup PRIMARY KEY (CurriculumId, AdGroupId)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_lms_CurriculumGroup_Group'
                 AND object_id = OBJECT_ID('lms.CurriculumGroup'))
CREATE INDEX IX_lms_CurriculumGroup_Group ON lms.CurriculumGroup (AdGroupId);
GO
