-- forit-LMS — migration 0002: course category, curriculum, certificates
-- Target: shared `forit` Azure SQL DB, lms.* schema. Run as foritadmin.
-- Completion tracking itself reuses the lms.Enrollment / lms.Progress tables
-- already created in 0001 — this migration only adds the grouping (Curriculum)
-- and the credential (Certificate) layers on top of them.
--
-- Every statement is guarded so the migration is safe to re-run — the starter
-- course seeder (db/seed/load-starter-courses) applies this batch-by-batch.

-- Course category — lets the catalog group security vs productivity courses,
-- and lets the certificate layer decide expiry policy per category.
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID('lms.Course') AND name = 'Category')
    ALTER TABLE lms.Course ADD Category NVARCHAR(32) NULL;
GO

-- A Curriculum is a named, ordered bundle of courses for one tenant. The row
-- flagged IsDefault = 1 is the bundle every learner of that tenant is measured
-- against; its courses carry IsMandatory to separate required from optional.
IF OBJECT_ID('lms.Curriculum', 'U') IS NULL
CREATE TABLE lms.Curriculum (
    CurriculumId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_Curriculum PRIMARY KEY,
    TenantId     UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_Curriculum_Tenant REFERENCES lms.Tenant(TenantId),
    Name         NVARCHAR(256)    NOT NULL,
    Slug         NVARCHAR(128)    NOT NULL,
    Description  NVARCHAR(MAX)    NULL,
    IsDefault    BIT              NOT NULL CONSTRAINT DF_lms_Curriculum_Default DEFAULT (0),
    CreatedAt    DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_Curriculum_Created DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_lms_Curriculum_TenantSlug UNIQUE (TenantId, Slug)
);
GO

-- At most one default curriculum per tenant.
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'UX_lms_Curriculum_OneDefault'
                 AND object_id = OBJECT_ID('lms.Curriculum'))
CREATE UNIQUE INDEX UX_lms_Curriculum_OneDefault
    ON lms.Curriculum (TenantId) WHERE IsDefault = 1;
GO

IF OBJECT_ID('lms.CurriculumCourse', 'U') IS NULL
CREATE TABLE lms.CurriculumCourse (
    CurriculumId UNIQUEIDENTIFIER NOT NULL
        CONSTRAINT FK_lms_CurriculumCourse_Curriculum REFERENCES lms.Curriculum(CurriculumId) ON DELETE CASCADE,
    CourseId     UNIQUEIDENTIFIER NOT NULL
        CONSTRAINT FK_lms_CurriculumCourse_Course REFERENCES lms.Course(CourseId) ON DELETE CASCADE,
    IsMandatory  BIT              NOT NULL CONSTRAINT DF_lms_CurriculumCourse_Mandatory DEFAULT (0),
    OrderIndex   INT              NOT NULL CONSTRAINT DF_lms_CurriculumCourse_Order DEFAULT (0),
    CONSTRAINT PK_lms_CurriculumCourse PRIMARY KEY (CurriculumId, CourseId)
);
GO

-- A Certificate is minted once when a learner completes a course. CourseTitle
-- and LearnerName are denormalized on purpose: a certificate is an immutable
-- record, so a later course rename or display-name change must not rewrite
-- what an already-issued certificate says. ExpiresAt is set for time-bound
-- training (annual security awareness) and NULL for evergreen courses.
IF OBJECT_ID('lms.Certificate', 'U') IS NULL
CREATE TABLE lms.Certificate (
    CertificateId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_Certificate PRIMARY KEY,
    TenantId      UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_Certificate_Tenant REFERENCES lms.Tenant(TenantId),
    LearnerId     UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_Certificate_Learner REFERENCES lms.Learner(LearnerId),
    CourseId      UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_Certificate_Course REFERENCES lms.Course(CourseId),
    SerialNo      NVARCHAR(32)     NOT NULL,
    CourseTitle   NVARCHAR(256)    NOT NULL,
    LearnerName   NVARCHAR(256)    NOT NULL,
    IssuedAt      DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_Certificate_Issued DEFAULT (SYSUTCDATETIME()),
    ExpiresAt     DATETIME2(3)     NULL,
    RevokedAt     DATETIME2(3)     NULL,
    CONSTRAINT UQ_lms_Certificate_LearnerCourse UNIQUE (LearnerId, CourseId),
    CONSTRAINT UQ_lms_Certificate_Serial UNIQUE (SerialNo)
);
GO
