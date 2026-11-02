-- 0030_ai_authoring_jobs: lms.AssetIngestion becomes the AI authoring job
-- queue (docs/plans/2026-10-29-ai-authoring.md, slice A2). A worker claims a
-- row under a lease, works through extract, outline, lessons and saving, and
-- keeps what each stage produced in WorkJson so a retry doesn't pay for it
-- twice. Rows the CLI wrote before this ('running', 'completed', 'failed')
-- stay valid; their OptionsJson stays NULL, which is how the backfill finds
-- them. The queue never claims one: a 'running' one more than an hour old is
-- a CLI run that died, and is marked failed here.
-- CreatedBy stays nullable so the old CLI's insert still works between this
-- migration and the deploy; the app writes it on every new row.

IF COL_LENGTH('lms.AssetIngestion', 'CreatedBy') IS NULL
    ALTER TABLE lms.AssetIngestion ADD CreatedBy NVARCHAR(256) NULL;
IF COL_LENGTH('lms.AssetIngestion', 'UpdatedAt') IS NULL
    ALTER TABLE lms.AssetIngestion ADD UpdatedAt DATETIME2(3) NOT NULL
        CONSTRAINT DF_lms_AssetIngestion_Updated DEFAULT (SYSUTCDATETIME());
IF COL_LENGTH('lms.AssetIngestion', 'Stage') IS NULL
    ALTER TABLE lms.AssetIngestion ADD Stage NVARCHAR(16) NULL
        CONSTRAINT CK_lms_AssetIngestion_Stage CHECK (Stage IN ('extract', 'outline', 'lessons', 'saving'));
IF COL_LENGTH('lms.AssetIngestion', 'LessonsDone') IS NULL
    ALTER TABLE lms.AssetIngestion ADD LessonsDone INT NOT NULL
        CONSTRAINT DF_lms_AssetIngestion_LessonsDone DEFAULT (0);
IF COL_LENGTH('lms.AssetIngestion', 'LessonsTotal') IS NULL
    ALTER TABLE lms.AssetIngestion ADD LessonsTotal INT NULL;
IF COL_LENGTH('lms.AssetIngestion', 'Attempts') IS NULL
    ALTER TABLE lms.AssetIngestion ADD Attempts INT NOT NULL
        CONSTRAINT DF_lms_AssetIngestion_Attempts DEFAULT (0);
IF COL_LENGTH('lms.AssetIngestion', 'NotBefore') IS NULL
    ALTER TABLE lms.AssetIngestion ADD NotBefore DATETIME2(3) NOT NULL
        CONSTRAINT DF_lms_AssetIngestion_NotBefore DEFAULT (SYSUTCDATETIME());
IF COL_LENGTH('lms.AssetIngestion', 'LeaseUntil') IS NULL
    ALTER TABLE lms.AssetIngestion ADD LeaseUntil DATETIME2(3) NULL;
IF COL_LENGTH('lms.AssetIngestion', 'LeaseToken') IS NULL
    ALTER TABLE lms.AssetIngestion ADD LeaseToken UNIQUEIDENTIFIER NULL;
IF COL_LENGTH('lms.AssetIngestion', 'OptionsJson') IS NULL
    ALTER TABLE lms.AssetIngestion ADD OptionsJson NVARCHAR(MAX) NULL
        CONSTRAINT CK_lms_AssetIngestion_OptionsJson CHECK (OptionsJson IS NULL OR ISJSON(OptionsJson) = 1);
IF COL_LENGTH('lms.AssetIngestion', 'WorkJson') IS NULL
    ALTER TABLE lms.AssetIngestion ADD WorkJson NVARCHAR(MAX) NULL
        CONSTRAINT CK_lms_AssetIngestion_WorkJson CHECK (WorkJson IS NULL OR ISJSON(WorkJson) = 1);
IF COL_LENGTH('lms.AssetIngestion', 'WarningsJson') IS NULL
    ALTER TABLE lms.AssetIngestion ADD WarningsJson NVARCHAR(MAX) NULL
        CONSTRAINT CK_lms_AssetIngestion_WarningsJson CHECK (WarningsJson IS NULL OR ISJSON(WarningsJson) = 1);
GO

-- Rows from before the queue: the author is the course's creator where the
-- run made one, else the CLI's default; last touched when created.
IF EXISTS (SELECT 1 FROM lms.AssetIngestion
            WHERE OptionsJson IS NULL AND (CreatedBy IS NULL OR UpdatedAt <> CreatedAt))
    UPDATE i
       SET CreatedBy = COALESCE(i.CreatedBy, c.CreatedBy, N'ingest-cli'),
           UpdatedAt = i.CreatedAt
      FROM lms.AssetIngestion i
      LEFT JOIN lms.Course c ON c.CourseId = i.ResultCourseId AND c.TenantId = i.TenantId
     WHERE i.OptionsJson IS NULL AND (i.CreatedBy IS NULL OR i.UpdatedAt <> i.CreatedAt);
IF EXISTS (SELECT 1 FROM lms.AssetIngestion
            WHERE OptionsJson IS NULL AND Status = 'running' AND CreatedAt < DATEADD(hour, -1, SYSUTCDATETIME()))
    UPDATE lms.AssetIngestion
       SET Status = 'failed', ErrorMessage = N'The command-line run stopped before it finished.'
     WHERE OptionsJson IS NULL AND Status = 'running' AND CreatedAt < DATEADD(hour, -1, SYSUTCDATETIME());
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
                WHERE name = 'CK_lms_AssetIngestion_Status'
                  AND parent_object_id = OBJECT_ID('lms.AssetIngestion'))
    ALTER TABLE lms.AssetIngestion ADD CONSTRAINT CK_lms_AssetIngestion_Status
        CHECK (Status IN ('queued', 'running', 'completed', 'failed', 'cancelled'));
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
                WHERE name = 'IX_lms_AssetIngestion_StatusNotBefore'
                  AND object_id = OBJECT_ID('lms.AssetIngestion'))
    CREATE INDEX IX_lms_AssetIngestion_StatusNotBefore
        ON lms.AssetIngestion (Status, NotBefore);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
                WHERE name = 'IX_lms_AssetIngestion_TenantCreated'
                  AND object_id = OBJECT_ID('lms.AssetIngestion'))
    CREATE INDEX IX_lms_AssetIngestion_TenantCreated
        ON lms.AssetIngestion (TenantId, CreatedAt DESC);
GO
