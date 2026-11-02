-- 0031_ai_authoring_usage: the model tokens an AI authoring job spent
-- (docs/plans/2026-10-29-ai-authoring.md, Risks: Cost). Per model: calls,
-- input, output, cache-write and cache-read tokens, summed across every
-- attempt of the job. The job writes the running total with each write it
-- already makes, so a retry adds only its own calls. Rows from before this
-- stay NULL, which reads as no usage recorded.

IF COL_LENGTH('lms.AssetIngestion', 'UsageJson') IS NULL
    ALTER TABLE lms.AssetIngestion ADD UsageJson NVARCHAR(MAX) NULL
        CONSTRAINT CK_lms_AssetIngestion_UsageJson CHECK (UsageJson IS NULL OR ISJSON(UsageJson) = 1);
GO
