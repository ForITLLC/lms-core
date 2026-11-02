-- forit-LMS — migration 0019: device keys for the ForIT LMS iPhone app.
-- The app signs in with ForIT Sign-in (shared public client, auth code + PKCE)
-- and posts the id_token once to POST /api/mobile/token. That route binds the
-- LMS tenant exactly as the web callback does and mints an lmk_ device key;
-- only its sha256 is stored here. Every /api/mobile request resolves the key
-- to the session columns below, so the key carries the same identity, tenant
-- and role the web cookie would. DELETE /api/mobile/token revokes it.
-- Idempotent: OBJECT_ID / sys.indexes guards.

IF OBJECT_ID('lms.MobileDeviceKey', 'U') IS NULL
CREATE TABLE lms.MobileDeviceKey (
    DeviceKeyId  UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_MobileDeviceKey PRIMARY KEY,
    TenantId     UNIQUEIDENTIFIER NOT NULL
                    CONSTRAINT FK_lms_MobileDeviceKey_Tenant REFERENCES lms.Tenant(TenantId),
    TokenHash    BINARY(32)       NOT NULL,                 -- sha256(full key)
    Email        NVARCHAR(320)    NOT NULL,
    DisplayName  NVARCHAR(256)    NOT NULL,
    AzureOid     NVARCHAR(64)     NOT NULL,
    AadTenantId  NVARCHAR(64)     NOT NULL,                 -- validated id_token tid
    Issuer       NVARCHAR(256)    NOT NULL,                 -- validated id_token iss
    Role         NVARCHAR(32)     NOT NULL,
    GroupsJson   NVARCHAR(MAX)    NULL,
    DeviceName   NVARCHAR(128)    NULL,
    CreatedAt    DATETIME2(3)     NOT NULL
                    CONSTRAINT DF_lms_MobileDeviceKey_Created DEFAULT (SYSUTCDATETIME()),
    ExpiresAt    DATETIME2(3)     NOT NULL,
    LastUsedAt   DATETIME2(3)     NULL,
    RevokedAt    DATETIME2(3)     NULL,
    CONSTRAINT UQ_lms_MobileDeviceKey_TokenHash UNIQUE (TokenHash)
);
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_lms_MobileDeviceKey_Owner' AND object_id = OBJECT_ID('lms.MobileDeviceKey')
)
CREATE INDEX IX_lms_MobileDeviceKey_Owner ON lms.MobileDeviceKey (TenantId, AzureOid);
GO
