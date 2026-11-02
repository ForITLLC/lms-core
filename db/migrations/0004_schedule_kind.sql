-- 0004_schedule_kind — explicit per-course scheduling mode.
--   annual    -> Jan 31 each year
--   recurring -> every RecurrenceMonths from learner start_date / last issue
--   NULL      -> evergreen, no expiry
-- Replaces the implicit Category='security' heuristic in computeExpiresAt.

IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID('lms.Course') AND name = 'ScheduleKind')
    ALTER TABLE lms.Course ADD ScheduleKind NVARCHAR(16) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
               WHERE name = 'CK_lms_Course_ScheduleKind'
                 AND parent_object_id = OBJECT_ID('lms.Course'))
    ALTER TABLE lms.Course ADD CONSTRAINT CK_lms_Course_ScheduleKind
        CHECK (ScheduleKind IS NULL OR ScheduleKind IN ('annual','recurring'));
GO

-- Backfill: phishing course is annual; clear its now-unused RecurrenceMonths.
UPDATE lms.Course
   SET ScheduleKind = 'annual',
       RecurrenceMonths = NULL
 WHERE Slug = 'phishing-security-awareness';
GO
