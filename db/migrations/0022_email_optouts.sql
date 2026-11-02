-- forit-LMS — migration 0022: who switched which email off.
-- @foritllc/mail's packages/mail/sql/email-optouts.sql (0.6.0) with APP_SCHEMA=lms:
-- scripts/run-migration.cjs has no sqlcmd variables. createSqlOptOutStore reads and
-- writes it for the signed unsubscribe link, the one-click POST, the account switch
-- on /dashboard/settings and the digest's send-time check (lib/email-optout.ts).
--
-- One row per (TenantKey, Subject, Category); OffAt NULL means on. TenantKey is the
-- lower-case lms.Tenant id. Subject is 'e:<HMAC of tenant + address>': the address
-- itself is never stored. The key columns are binary-collated so keys compare
-- exactly, as the package's memory store compares them.
-- Idempotent: OBJECT_ID guard.

SET NOCOUNT ON;

IF SCHEMA_ID(N'lms') IS NULL
    THROW 50302, 'Schema lms does not exist.', 1;
GO

IF OBJECT_ID(N'[lms].[EmailOptOuts]', N'U') IS NULL
BEGIN
    CREATE TABLE [lms].[EmailOptOuts] (
        TenantKey  NVARCHAR(64)  COLLATE Latin1_General_100_BIN2 NOT NULL,  -- the tenant the link was minted for
        Subject    VARCHAR(80)   COLLATE Latin1_General_100_BIN2 NOT NULL,  -- 'u:<userId>' | 'e:<hash>'
        Category   VARCHAR(64)   COLLATE Latin1_General_100_BIN2 NOT NULL,  -- lower-case kebab-case switch, e.g. 'learning-summary'
        OffAt      DATETIME2     NULL,                      -- first switched off; NULL = on
        Source     VARCHAR(16)   NOT NULL,                  -- who flipped it last
        UpdatedAt  DATETIME2     NOT NULL CONSTRAINT DF_EmailOptOuts_UpdatedAt DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_EmailOptOuts PRIMARY KEY (TenantKey, Subject, Category),
        CONSTRAINT CK_EmailOptOuts_Source CHECK (Source IN ('link', 'one-click', 'account', 'admin'))
    );
END
GO
