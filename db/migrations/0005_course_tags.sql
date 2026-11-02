-- Free-form tags for the course catalog. Stored as a JSON array of strings
-- on the course row itself; no dimension table because the catalog stays in
-- the low hundreds and search filters apply-side on a per-tenant list that
-- already lives in memory. The few queries that want to filter by tag use
-- LIKE '%"phishing"%' (case-insensitive due to default collation) or
-- OPENJSON for stricter matches.

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('lms.Course')
       AND name = 'Tags'
)
BEGIN
    ALTER TABLE lms.Course
        ADD Tags NVARCHAR(MAX) NULL;
END
GO

-- Sanity guard: anything stored must parse as JSON. Drop+add so the constraint
-- is idempotent (NOCHECK on add tolerates existing NULLs).
IF EXISTS (
    SELECT 1 FROM sys.check_constraints
     WHERE name = 'CK_lms_Course_Tags_Json'
)
BEGIN
    ALTER TABLE lms.Course DROP CONSTRAINT CK_lms_Course_Tags_Json;
END
GO

ALTER TABLE lms.Course WITH NOCHECK
    ADD CONSTRAINT CK_lms_Course_Tags_Json
        CHECK (Tags IS NULL OR ISJSON(Tags) = 1);
GO
