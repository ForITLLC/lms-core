-- 0036_personnel_link: who a learner is at the operator, and the rules a
-- correction of a training record keeps (docs/plans/2026-10-29-training-records-design.md
-- §3.1 and §3.3, slice R2a).
-- lms.PersonnelLink holds one row per change to a learner's duty position,
-- employee number, hire and leave dates and for-CrewRecords reference, each
-- in force from EffectiveFrom. Rows are never changed or removed: a new
-- position is a new row with a later EffectiveFrom, and a row entered wrongly
-- is replaced by one naming it in SupersedesLinkId with a Reason. The LMS
-- keeps no licence or medical columns (design §3.6). Its learner key is
-- (TenantId, LearnerId), so a row can't name another tenant's learner, and a
-- superseding row must name a row of the same tenant and learner.
-- A correction of a training record is a new lms.TrainingRecord row naming
-- the one it corrects in CorrectsRecordId (0034). From here the database
-- holds it to three rules: its reason is in PayloadJson as correctionReason,
-- which the row hash covers; it names a record of the same tenant and the
-- same learner; and a record is corrected at most once, so a record's
-- corrections are one line and the newest row is the one in force. No writer
-- before R2 sets CorrectsRecordId, so every existing row meets all three and
-- the new constraints are checked against them as they are added. No
-- existing row is changed.
-- Permissions are unchanged: no GRANT, DENY or REVOKE.

IF OBJECT_ID('lms.PersonnelLink', 'U') IS NULL
    CREATE TABLE lms.PersonnelLink (
        PersonnelLinkId      UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_PersonnelLink PRIMARY KEY,
        TenantId             UNIQUEIDENTIFIER NOT NULL
                                 CONSTRAINT FK_lms_PersonnelLink_Tenant REFERENCES lms.Tenant(TenantId),
        LearnerId            UNIQUEIDENTIFIER NOT NULL,
        DutyPosition         NVARCHAR(32)     NOT NULL
                                 CONSTRAINT CK_lms_PersonnelLink_DutyPosition CHECK (DutyPosition IN (
                                     'pilot', 'flight_attendant', 'dispatcher', 'dg', 'ame', 'other')),
        EmployeeNo           NVARCHAR(64)     NULL,
        HireDate             DATE             NULL,
        LeaveDate            DATE             NULL,
        EffectiveFrom        DATE             NOT NULL,
        CrewRecordsPersonRef NVARCHAR(128)    NULL,
        SupersedesLinkId     UNIQUEIDENTIFIER NULL,
        Reason               NVARCHAR(1000)   NULL,
        RecordedBy           NVARCHAR(320)    NOT NULL,
        RecordedAt           DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_PersonnelLink_RecordedAt DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT UQ_lms_PersonnelLink_TenantLearnerLink UNIQUE (TenantId, LearnerId, PersonnelLinkId),
        CONSTRAINT FK_lms_PersonnelLink_Learner FOREIGN KEY (TenantId, LearnerId)
            REFERENCES lms.Learner (TenantId, LearnerId),
        CONSTRAINT FK_lms_PersonnelLink_Supersedes FOREIGN KEY (TenantId, LearnerId, SupersedesLinkId)
            REFERENCES lms.PersonnelLink (TenantId, LearnerId, PersonnelLinkId),
        CONSTRAINT CK_lms_PersonnelLink_Dates CHECK (LeaveDate IS NULL OR HireDate IS NULL OR LeaveDate >= HireDate),
        CONSTRAINT CK_lms_PersonnelLink_RecordedBy CHECK (LEN(LTRIM(RTRIM(RecordedBy))) > 0),
        CONSTRAINT CK_lms_PersonnelLink_Supersedes CHECK (SupersedesLinkId IS NULL OR SupersedesLinkId <> PersonnelLinkId),
        CONSTRAINT CK_lms_PersonnelLink_Reason CHECK (
            SupersedesLinkId IS NULL OR (Reason IS NOT NULL AND LEN(LTRIM(RTRIM(Reason))) > 0))
    );
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
                WHERE name = 'IX_lms_PersonnelLink_TenantLearnerEffective'
                  AND object_id = OBJECT_ID('lms.PersonnelLink'))
    CREATE INDEX IX_lms_PersonnelLink_TenantLearnerEffective
        ON lms.PersonnelLink (TenantId, LearnerId, EffectiveFrom);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
                WHERE name = 'UX_lms_PersonnelLink_Supersedes'
                  AND object_id = OBJECT_ID('lms.PersonnelLink'))
    CREATE UNIQUE INDEX UX_lms_PersonnelLink_Supersedes
        ON lms.PersonnelLink (SupersedesLinkId) WHERE SupersedesLinkId IS NOT NULL;
GO

CREATE OR ALTER TRIGGER lms.TR_lms_PersonnelLink_NoUpdate
    ON lms.PersonnelLink
    INSTEAD OF UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    THROW 51038, N'lms.PersonnelLink is append-only: a change is a new row, and a row entered wrongly is superseded by one that names it.', 1;
END;
GO

CREATE OR ALTER TRIGGER lms.TR_lms_PersonnelLink_NoDelete
    ON lms.PersonnelLink
    INSTEAD OF DELETE
AS
BEGIN
    SET NOCOUNT ON;
    THROW 51039, N'lms.PersonnelLink is append-only: rows are never deleted.', 1;
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
                WHERE name = 'CK_lms_TrainingRecord_CorrectionReason'
                  AND parent_object_id = OBJECT_ID('lms.TrainingRecord'))
    ALTER TABLE lms.TrainingRecord WITH CHECK
        ADD CONSTRAINT CK_lms_TrainingRecord_CorrectionReason CHECK (
            CASE
                WHEN CorrectsRecordId IS NULL THEN 1
                WHEN PayloadJson IS NULL OR ISJSON(PayloadJson) = 0 THEN 0
                WHEN LEN(LTRIM(RTRIM(ISNULL(JSON_VALUE(PayloadJson, '$.correctionReason'), N'')))) > 0 THEN 1
                ELSE 0
            END = 1);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
                WHERE name = 'UX_lms_TrainingRecord_TenantLearnerRecord'
                  AND object_id = OBJECT_ID('lms.TrainingRecord'))
    CREATE UNIQUE INDEX UX_lms_TrainingRecord_TenantLearnerRecord
        ON lms.TrainingRecord (TenantId, LearnerId, RecordId);
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys
                WHERE name = 'FK_lms_TrainingRecord_CorrectsSamePerson'
                  AND parent_object_id = OBJECT_ID('lms.TrainingRecord'))
    ALTER TABLE lms.TrainingRecord WITH CHECK
        ADD CONSTRAINT FK_lms_TrainingRecord_CorrectsSamePerson FOREIGN KEY (TenantId, LearnerId, CorrectsRecordId)
            REFERENCES lms.TrainingRecord (TenantId, LearnerId, RecordId);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
                WHERE name = 'UX_lms_TrainingRecord_Corrects'
                  AND object_id = OBJECT_ID('lms.TrainingRecord'))
    CREATE UNIQUE INDEX UX_lms_TrainingRecord_Corrects
        ON lms.TrainingRecord (CorrectsRecordId) WHERE CorrectsRecordId IS NOT NULL;
GO
