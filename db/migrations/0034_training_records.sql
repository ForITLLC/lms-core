-- 0034_training_records: the append-only training record and its per-tenant
-- hash chain (docs/plans/2026-10-29-training-records-design.md §3.1, slice R1a).
-- lms.TrainingRecord holds one row per training, examination, check or
-- qualification event for one person. Rows are never changed or removed:
-- a correction (R2) is a new row naming the one it corrects in
-- CorrectsRecordId, and the INSTEAD OF UPDATE and INSTEAD OF DELETE triggers
-- below refuse any UPDATE or DELETE, whoever runs it.
-- Seq counts a tenant's records from 1. RowHash is SHA-256 over PrevHash (the
-- RowHash of Seq - 1, or 32 zero bytes for Seq 1) and the row's canonical
-- bytes; the app computes it (lib/records/chain.ts) so the recipe lives in
-- one place. lms.TrainingRecordChain is the tenant's chain head: an append
-- takes its row under UPDLOCK, checks it still names the Seq and hash the
-- app chained from, inserts the record and moves the head, all in one
-- transaction, so two writers can't fork the chain.
-- LearnerId is a NO ACTION foreign key: the app never deletes a learner, and
-- a delete of someone who has records now fails instead of orphaning them.
-- PersonName and PersonEmail are snapshots taken at write time. The course,
-- version, quiz and attempt ids are plain ids with no foreign key, so
-- deleting or editing a course or an attempt never touches a record. No
-- foreign key here cascades: SQL Server allows no INSTEAD OF trigger on a
-- table with a cascading one.
-- Permissions are unchanged. The DENY UPDATE, DELETE on lms.TrainingRecord
-- for the app's login is a security change and comes with its own decided
-- card (design §3.1); until then the triggers are the guard.

IF OBJECT_ID('lms.TrainingRecordChain', 'U') IS NULL
    CREATE TABLE lms.TrainingRecordChain (
        TenantId  UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_TrainingRecordChain PRIMARY KEY
                      CONSTRAINT FK_lms_TrainingRecordChain_Tenant REFERENCES lms.Tenant(TenantId),
        LastSeq   BIGINT           NOT NULL CONSTRAINT CK_lms_TrainingRecordChain_LastSeq CHECK (LastSeq >= 0),
        LastHash  VARBINARY(32)    NOT NULL CONSTRAINT CK_lms_TrainingRecordChain_LastHash CHECK (DATALENGTH(LastHash) = 32),
        UpdatedAt DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_TrainingRecordChain_UpdatedAt DEFAULT (SYSUTCDATETIME())
    );
GO

IF OBJECT_ID('lms.TrainingRecord', 'U') IS NULL
    CREATE TABLE lms.TrainingRecord (
        RecordId         UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_TrainingRecord PRIMARY KEY,
        TenantId         UNIQUEIDENTIFIER NOT NULL
                             CONSTRAINT FK_lms_TrainingRecord_Tenant REFERENCES lms.Tenant(TenantId),
        Seq              BIGINT           NOT NULL CONSTRAINT CK_lms_TrainingRecord_Seq CHECK (Seq >= 1),
        LearnerId        UNIQUEIDENTIFIER NOT NULL
                             CONSTRAINT FK_lms_TrainingRecord_Learner REFERENCES lms.Learner(LearnerId),
        PersonName       NVARCHAR(256)    NOT NULL,
        PersonEmail      NVARCHAR(320)    NOT NULL,
        Kind             NVARCHAR(32)     NOT NULL
                             CONSTRAINT CK_lms_TrainingRecord_Kind CHECK (Kind IN (
                                 'course_completion', 'exam_pass', 'exam_fail', 'exam_attempt_pending', 'grade_change',
                                 'check', 'ojt', 'line_indoc', 'familiarization', 'monitor', 'qualification',
                                 'vendor_training', 'acp_ppc')),
        OccurredAt       DATETIME2(3)     NOT NULL,
        CourseId         UNIQUEIDENTIFIER NULL,
        CourseVersionId  UNIQUEIDENTIFIER NULL,
        CourseTitle      NVARCHAR(256)    NULL,
        QuizId           UNIQUEIDENTIFIER NULL,
        AttemptId        UNIQUEIDENTIFIER NULL,
        Result           NVARCHAR(16)     NOT NULL
                             CONSTRAINT CK_lms_TrainingRecord_Result CHECK (Result IN (
                                 'pass', 'fail', 'pending', 'completed', 'attended', 'incomplete')),
        Score            INT              NULL,
        PassingScore     INT              NULL,
        FailureDetail    NVARCHAR(1000)   NULL,
        Source           NVARCHAR(16)     NOT NULL
                             CONSTRAINT CK_lms_TrainingRecord_Source CHECK (Source IN ('auto', 'manual', 'backfill')),
        RecordedBy       NVARCHAR(320)    NOT NULL,
        RecordedAt       DATETIME2(3)     NOT NULL,
        CorrectsRecordId UNIQUEIDENTIFIER NULL
                             CONSTRAINT FK_lms_TrainingRecord_Corrects REFERENCES lms.TrainingRecord(RecordId),
        PayloadJson      NVARCHAR(MAX)    NULL
                             CONSTRAINT CK_lms_TrainingRecord_PayloadJson CHECK (PayloadJson IS NULL OR ISJSON(PayloadJson) = 1),
        PrevHash         VARBINARY(32)    NOT NULL CONSTRAINT CK_lms_TrainingRecord_PrevHash CHECK (DATALENGTH(PrevHash) = 32),
        RowHash          VARBINARY(32)    NOT NULL CONSTRAINT CK_lms_TrainingRecord_RowHash CHECK (DATALENGTH(RowHash) = 32),
        CONSTRAINT UQ_lms_TrainingRecord_TenantSeq UNIQUE (TenantId, Seq),
        CONSTRAINT CK_lms_TrainingRecord_KindResult CHECK (
            (Kind = 'course_completion' AND Result = 'completed')
            OR (Kind = 'exam_pass' AND Result = 'pass')
            OR (Kind = 'exam_fail' AND Result = 'fail')
            OR (Kind = 'exam_attempt_pending' AND Result = 'pending')
            OR (Kind = 'grade_change' AND Result IN ('pass', 'fail'))
            OR (Kind IN ('check', 'ojt', 'line_indoc', 'familiarization', 'monitor', 'qualification', 'vendor_training', 'acp_ppc')
                AND Result IN ('pass', 'fail', 'completed', 'attended', 'incomplete'))),
        CONSTRAINT CK_lms_TrainingRecord_Score CHECK (
            (Score IS NULL OR (Score >= 0 AND Score <= 100))
            AND (PassingScore IS NULL OR (PassingScore >= 0 AND PassingScore <= 100))
            AND (Kind NOT IN ('exam_pass', 'exam_fail', 'grade_change') OR (Score IS NOT NULL AND PassingScore IS NOT NULL))
            AND (Result <> 'pass' OR Score IS NULL OR PassingScore IS NULL OR Score >= PassingScore)
            AND (Result <> 'fail' OR Score IS NULL OR PassingScore IS NULL OR Score < PassingScore)),
        CONSTRAINT CK_lms_TrainingRecord_FailureDetail CHECK (
            Result <> 'fail' OR (FailureDetail IS NOT NULL AND LEN(LTRIM(RTRIM(FailureDetail))) > 0)),
        CONSTRAINT CK_lms_TrainingRecord_RecordedBy CHECK (LEN(LTRIM(RTRIM(RecordedBy))) > 0),
        CONSTRAINT CK_lms_TrainingRecord_Corrects CHECK (CorrectsRecordId IS NULL OR CorrectsRecordId <> RecordId)
    );
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
                WHERE name = 'IX_lms_TrainingRecord_TenantLearnerOccurred'
                  AND object_id = OBJECT_ID('lms.TrainingRecord'))
    CREATE INDEX IX_lms_TrainingRecord_TenantLearnerOccurred
        ON lms.TrainingRecord (TenantId, LearnerId, OccurredAt);
GO

CREATE OR ALTER TRIGGER lms.TR_lms_TrainingRecord_NoUpdate
    ON lms.TrainingRecord
    INSTEAD OF UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    THROW 51034, N'lms.TrainingRecord is append-only: a correction is a new row that names the record it corrects.', 1;
END;
GO

CREATE OR ALTER TRIGGER lms.TR_lms_TrainingRecord_NoDelete
    ON lms.TrainingRecord
    INSTEAD OF DELETE
AS
BEGIN
    SET NOCOUNT ON;
    THROW 51035, N'lms.TrainingRecord is append-only: records are never deleted.', 1;
END;
GO
