-- forit-LMS — stamp the AAD object id on lms.Learner so the UI can pull a
-- directory profile picture (Microsoft Graph /photo/$value) keyed by oid.
-- lms.AppUser already carries AzureOid; lms.Learner did not. The learners-sync
-- cron has the oid in hand (lib/graph.ts:listLicensedUsers.aadOid) and
-- resolveLearner now persists it. Idempotent: re-runnable, IF NOT EXISTS guard
-- style matching 0007 / 0008 / 0009.

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('lms.Learner')
       AND name = 'AzureOid'
)
BEGIN
    ALTER TABLE lms.Learner ADD AzureOid NVARCHAR(64) NULL;
END
GO
