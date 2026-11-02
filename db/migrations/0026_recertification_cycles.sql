-- 0026_recertification_cycles: numbered cycles for recurrent courses
-- (docs/plans/2026-10-27-recertification-design.md). A renewal starts a new
-- cycle on the same enrolment. Each cycle earns its own certificate, and the
-- finished cycle's block progress moves to lms.ProgressHistory.
--
-- Existing rows become cycle 1 through the defaults. The code before the
-- re-certification release still works on this schema: it never sets CycleNo,
-- and its certificate MERGE still matches on (LearnerId, CourseId).

IF COL_LENGTH('lms.Enrollment', 'CycleNo') IS NULL
    ALTER TABLE lms.Enrollment ADD CycleNo INT NOT NULL
        CONSTRAINT DF_lms_Enrollment_CycleNo DEFAULT (1);
GO

-- NULL means cycle 1, which started at EnrolledAt.
IF COL_LENGTH('lms.Enrollment', 'CycleStartedAt') IS NULL
    ALTER TABLE lms.Enrollment ADD CycleStartedAt DATETIME2(3) NULL;
GO

IF COL_LENGTH('lms.Certificate', 'CycleNo') IS NULL
    ALTER TABLE lms.Certificate ADD CycleNo INT NOT NULL
        CONSTRAINT DF_lms_Certificate_CycleNo DEFAULT (1);
GO

IF EXISTS (SELECT 1 FROM sys.key_constraints
            WHERE name = 'UQ_lms_Certificate_LearnerCourse'
              AND parent_object_id = OBJECT_ID('lms.Certificate'))
    ALTER TABLE lms.Certificate DROP CONSTRAINT UQ_lms_Certificate_LearnerCourse;
GO

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints
                WHERE name = 'UQ_lms_Certificate_LearnerCourseCycle'
                  AND parent_object_id = OBJECT_ID('lms.Certificate'))
    ALTER TABLE lms.Certificate ADD CONSTRAINT UQ_lms_Certificate_LearnerCourseCycle
        UNIQUE (LearnerId, CourseId, CycleNo);
GO

IF OBJECT_ID('lms.ProgressHistory', 'U') IS NULL
    CREATE TABLE lms.ProgressHistory (
        LearnerId   UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_ProgressHistory_Learner REFERENCES lms.Learner(LearnerId),
        BlockId     UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_ProgressHistory_Block REFERENCES lms.Block(BlockId),
        CycleNo     INT              NOT NULL,
        CompletedAt DATETIME2(3)     NOT NULL,
        Seconds     INT              NOT NULL,
        ArchivedAt  DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_ProgressHistory_Archived DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_lms_ProgressHistory PRIMARY KEY (LearnerId, BlockId, CycleNo)
    );
GO
