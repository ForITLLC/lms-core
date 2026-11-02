import { createHash, randomBytes } from "node:crypto";
import { execute, query, queryOne } from "@/lib/db";

// Per-user API keys for the LMS REST API (/api/v1; migration 0012). Only the
// sha256 hash of the key is persisted; the plaintext is shown once at
// creation and is unrecoverable. TokenHash is a BINARY(32) column — the
// lib/db helper maps every string param to NVarChar, so the hash crosses the
// wire as a hex string and is converted with CONVERT(VARBINARY(32), @hex, 2)
// inside the SQL text for both INSERT and the WHERE lookup. An owner-only key
// (OwnerOnly, migration 0037) reads only its owner's own data: lib/api/bearer.ts
// refuses it unless the endpoint accepts it.

export interface MintedApiKey {
  apiKeyId: string;
  name: string;
  prefix: string;
  ownerOnly: boolean;
  plaintextKey: string;
}

export interface ApiKeyRow {
  apiKeyId: string;
  name: string;
  prefix: string;
  ownerOnly: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function mintApiKey(
  tenantId: string,
  appUserId: string,
  name: string,
  ownerOnly = false,
): Promise<MintedApiKey> {
  // prefix = "lms_" + 6 hex chars (display-only); the secret tail is another
  // 24 bytes of randomness so the full key is ~58 chars and ~192 bits.
  const prefixHex = randomBytes(3).toString("hex");
  const prefix = `lms_${prefixHex}`;
  const secret = randomBytes(24).toString("hex");
  const plaintextKey = `${prefix}_${secret}`;
  const tokenHashHex = sha256Hex(plaintextKey);

  const row = await queryOne<{ ApiKeyId: string }>(
    `INSERT INTO lms.ApiKey (ApiKeyId, TenantId, AppUserId, Name, Prefix, TokenHash, OwnerOnly, CreatedAt)
     OUTPUT CONVERT(varchar(64), inserted.ApiKeyId) AS ApiKeyId
     VALUES (NEWID(), @tenantId, @appUserId, @name, @prefix,
             CONVERT(VARBINARY(32), @tokenHashHex, 2), @ownerOnly, SYSUTCDATETIME())`,
    { tenantId, appUserId, name, prefix, tokenHashHex, ownerOnly },
  );
  if (!row) throw new Error("API key insert failed");

  return { apiKeyId: row.ApiKeyId, name, prefix, ownerOnly, plaintextKey };
}

export async function listApiKeys(
  tenantId: string,
  appUserId: string,
): Promise<ApiKeyRow[]> {
  const rows = await query<{
    ApiKeyId: string;
    Name: string;
    Prefix: string;
    OwnerOnly: boolean;
    CreatedAt: Date;
    LastUsedAt: Date | null;
    RevokedAt: Date | null;
  }>(
    `SELECT CONVERT(varchar(64), ApiKeyId) AS ApiKeyId,
            Name, Prefix, OwnerOnly, CreatedAt, LastUsedAt, RevokedAt
       FROM lms.ApiKey
      WHERE TenantId = @tenantId AND AppUserId = @appUserId
      ORDER BY CreatedAt DESC`,
    { tenantId, appUserId },
  );
  return rows.map((r) => ({
    apiKeyId: r.ApiKeyId,
    name: r.Name,
    prefix: r.Prefix,
    ownerOnly: r.OwnerOnly === true,
    createdAt: r.CreatedAt,
    lastUsedAt: r.LastUsedAt,
    revokedAt: r.RevokedAt,
  }));
}

export async function revokeApiKey(
  tenantId: string,
  appUserId: string,
  apiKeyId: string,
): Promise<boolean> {
  const affected = await execute(
    `UPDATE lms.ApiKey
        SET RevokedAt = SYSUTCDATETIME()
      WHERE ApiKeyId = @apiKeyId
        AND TenantId = @tenantId
        AND AppUserId = @appUserId
        AND RevokedAt IS NULL`,
    { apiKeyId, tenantId, appUserId },
  );
  return affected > 0;
}

export async function authenticateApiKey(
  plaintextKey: string,
): Promise<{ tenantId: string; appUserId: string; ownerOnly: boolean } | null> {
  const trimmed = plaintextKey.trim();
  if (!trimmed) return null;
  const tokenHashHex = sha256Hex(trimmed);

  const row = await queryOne<{ TenantId: string; AppUserId: string; OwnerOnly: boolean }>(
    `SELECT CONVERT(varchar(64), TenantId) AS TenantId,
            CONVERT(varchar(64), AppUserId) AS AppUserId,
            OwnerOnly
       FROM lms.ApiKey
      WHERE TokenHash = CONVERT(VARBINARY(32), @tokenHashHex, 2)
        AND RevokedAt IS NULL`,
    { tokenHashHex },
  );
  if (!row) return null;

  await execute(
    `UPDATE lms.ApiKey
        SET LastUsedAt = SYSUTCDATETIME()
      WHERE TokenHash = CONVERT(VARBINARY(32), @tokenHashHex, 2)`,
    { tokenHashHex },
  );

  // Anything but an explicit 0 reads as owner-only, so a key never gets wider than it was minted.
  return { tenantId: row.TenantId, appUserId: row.AppUserId, ownerOnly: row.OwnerOnly !== false };
}
