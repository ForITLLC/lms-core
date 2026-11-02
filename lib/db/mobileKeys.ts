import { createHash, randomBytes } from "node:crypto";
import { execute, queryOne } from "@/lib/db";
import type { LmsSession, Role } from "@/lib/auth-config";

// Device keys for the iPhone app (migration 0019). The key is shown to the
// app once; only its sha256 is stored, matched with the same
// CONVERT(VARBINARY(32), @hex, 2) trick as lib/db/apiKeys.ts.

export const DEVICE_KEY_PREFIX = "lmk_";
export const DEVICE_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const KEY_SHAPE = /^lmk_[A-Za-z0-9_-]{43}$/;

export function hasDeviceKeyShape(key: string | null | undefined): key is string {
  return typeof key === "string" && KEY_SHAPE.test(key);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface DeviceKeyOwner {
  tenantId: string;
  email: string;
  name: string;
  azureOid: string;
  tid: string;
  iss: string;
  role: Role;
  groups: string[];
  deviceName: string | null;
}

export async function mintDeviceKey(
  owner: DeviceKeyOwner,
  now = Date.now(),
): Promise<{ key: string; expiresAt: Date }> {
  const key = `${DEVICE_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(now + DEVICE_KEY_TTL_MS);
  await execute(
    `INSERT INTO lms.MobileDeviceKey
       (DeviceKeyId, TenantId, TokenHash, Email, DisplayName, AzureOid, AadTenantId,
        Issuer, Role, GroupsJson, DeviceName, ExpiresAt)
     VALUES (NEWID(), @tenantId, CONVERT(VARBINARY(32), @tokenHashHex, 2), @email, @name,
             @azureOid, @tid, @iss, @role, @groupsJson, @deviceName, @expiresAt)`,
    {
      tenantId: owner.tenantId,
      tokenHashHex: sha256Hex(key),
      email: owner.email,
      name: owner.name.slice(0, 256),
      azureOid: owner.azureOid,
      tid: owner.tid,
      iss: owner.iss,
      role: owner.role,
      groupsJson: owner.groups.length ? JSON.stringify(owner.groups) : null,
      deviceName: owner.deviceName ? owner.deviceName.slice(0, 128) : null,
      expiresAt,
    },
  );
  return { key, expiresAt };
}

interface KeyRow {
  TenantId: string;
  Email: string;
  DisplayName: string;
  AzureOid: string;
  AadTenantId: string;
  Issuer: string;
  Role: string;
  GroupsJson: string | null;
  ExpiresAt: Date;
}

function parseGroups(json: string | null): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((g): g is string => typeof g === "string") : [];
  } catch {
    return [];
  }
}

function asRole(value: string): Role {
  return value === "admin" || value === "author" || value === "learner" ? value : "learner";
}

/** The session a live device key stands for, else null (unknown, revoked or expired). */
export async function sessionForDeviceKey(key: string): Promise<LmsSession | null> {
  if (!hasDeviceKeyShape(key)) return null;
  const tokenHashHex = sha256Hex(key);
  const row = await queryOne<KeyRow>(
    `UPDATE lms.MobileDeviceKey
        SET LastUsedAt = SYSUTCDATETIME()
     OUTPUT CONVERT(varchar(64), inserted.TenantId) AS TenantId,
            inserted.Email, inserted.DisplayName, inserted.AzureOid, inserted.AadTenantId,
            inserted.Issuer, inserted.Role, inserted.GroupsJson, inserted.ExpiresAt
      WHERE TokenHash = CONVERT(VARBINARY(32), @tokenHashHex, 2)
        AND RevokedAt IS NULL
        AND ExpiresAt > SYSUTCDATETIME()`,
    { tokenHashHex },
  );
  if (!row) return null;
  return {
    email: row.Email,
    name: row.DisplayName,
    azureOid: row.AzureOid,
    tid: row.AadTenantId,
    expiresAt: new Date(row.ExpiresAt).getTime(),
    tenantId: row.TenantId,
    role: asRole(row.Role),
    groups: parseGroups(row.GroupsJson),
  };
}

export async function revokeDeviceKey(key: string): Promise<boolean> {
  if (!hasDeviceKeyShape(key)) return false;
  const affected = await execute(
    `UPDATE lms.MobileDeviceKey
        SET RevokedAt = SYSUTCDATETIME()
      WHERE TokenHash = CONVERT(VARBINARY(32), @tokenHashHex, 2)
        AND RevokedAt IS NULL`,
    { tokenHashHex: sha256Hex(key) },
  );
  return affected > 0;
}
