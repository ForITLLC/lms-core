-- 0037_api_key_owner_only: API keys that read only their owner's own data.
-- A key minted with "Reads only my own data" has OwnerOnly = 1. /api/v1 refuses
-- such a key with 403 insufficient_scope on every endpoint except those that
-- accept it, and those answer it only about the key's owner. Today that is
-- GET /api/v1/learning-summary for the owner's own address, which is what the
-- ForIT Daily email reads. Every existing key reads 0 and keeps acting with its
-- owner's role, as before. The flag is set at minting and never changed.
-- Permissions are unchanged: no GRANT, DENY or REVOKE.

IF COL_LENGTH('lms.ApiKey', 'OwnerOnly') IS NULL
    ALTER TABLE lms.ApiKey ADD OwnerOnly BIT NOT NULL CONSTRAINT DF_lms_ApiKey_OwnerOnly DEFAULT (0);
GO
