-- forit-LMS — migration 0012: per-user API keys for the LMS MCP endpoint.
-- A signed-in admin/author mints a key at /admin/integrations; the key
-- authenticates the streamable-HTTP MCP server at /api/mcp via an
-- Authorization: Bearer header. Only the sha256 hash of the key is stored —
-- the plaintext is shown once at creation and is never recoverable.
-- Idempotent: IF OBJECT_ID guard, matching 0003 style.

IF OBJECT_ID('lms.ApiKey', 'U') IS NULL
CREATE TABLE lms.ApiKey (
    ApiKeyId   UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_ApiKey PRIMARY KEY,
    TenantId   UNIQUEIDENTIFIER NOT NULL
                  CONSTRAINT FK_lms_ApiKey_Tenant REFERENCES lms.Tenant(TenantId),
    AppUserId  UNIQUEIDENTIFIER NOT NULL
                  CONSTRAINT FK_lms_ApiKey_AppUser REFERENCES lms.AppUser(AppUserId),
    Name       NVARCHAR(128)    NOT NULL,
    Prefix     NVARCHAR(16)     NOT NULL,                 -- display only, e.g. "lms_a1b2c3"
    TokenHash  BINARY(32)       NOT NULL,                 -- sha256(full key)
    CreatedAt  DATETIME2(3)     NOT NULL
                  CONSTRAINT DF_lms_ApiKey_Created DEFAULT (SYSUTCDATETIME()),
    LastUsedAt DATETIME2(3)     NULL,
    RevokedAt  DATETIME2(3)     NULL,
    CONSTRAINT UQ_lms_ApiKey_TokenHash UNIQUE (TokenHash)
);
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_lms_ApiKey_Owner' AND object_id = OBJECT_ID('lms.ApiKey')
)
CREATE INDEX IX_lms_ApiKey_Owner ON lms.ApiKey (TenantId, AppUserId);
GO
