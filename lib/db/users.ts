import { execute, query, queryOne } from "@/lib/db";
import type { Role } from "@/lib/auth-config";
import { asRole } from "@/lib/auth/roles";
import { RECORDS_ROLES, type RecordsRole } from "@/lib/auth/records-permissions";
import { chooseTenantBinding, type BindingIdentity, type TenantCandidate } from "@/lib/auth/tenant-binding";

export interface UpsertAppUserInput {
  tenantId: string;
  email: string;
  displayName: string;
  azureOid?: string;
  // When set, also writes Role so an admin-group sign-in promotes the
  // AppUser row. Omit to leave the existing Role untouched on update.
  role?: string;
  // A group-managed tenant's non-member: a stored admin drops to author,
  // any other stored role stays.
  demoteAdmin?: boolean;
}

// A new row is a learner. Staff roles come from the tenant's admin group, a
// seed migration or an admin, never from signing in.
export async function upsertAppUser(input: UpsertAppUserInput): Promise<void> {
  await execute(
    `MERGE lms.AppUser AS target
     USING (SELECT @tenantId AS TenantId, @email AS Email) AS src
     ON target.TenantId = src.TenantId AND target.Email = src.Email
     WHEN MATCHED THEN UPDATE
       SET DisplayName = @displayName,
           AzureOid    = @azureOid,
           Role        = CASE
                           WHEN @role IS NOT NULL THEN @role
                           WHEN @demoteAdmin = 1 AND Role = 'admin' THEN 'author'
                           ELSE Role
                         END,
           LastSeenAt  = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN INSERT
       (AppUserId, TenantId, Email, DisplayName, AzureOid, Role, LastSeenAt)
       VALUES (NEWID(), @tenantId, @email, @displayName, @azureOid,
               COALESCE(@role, 'learner'), SYSUTCDATETIME());`,
    {
      tenantId: input.tenantId,
      email: input.email,
      displayName: input.displayName,
      azureOid: input.azureOid ?? null,
      role: input.role ?? null,
      demoteAdmin: input.demoteAdmin ? 1 : 0,
    },
  );
}

const ROLE_TTL_MS = 60_000;
const roleCache = new Map<string, { role: Role; at: number }>();
const roleKey = (tenantId: string, email: string) => `${tenantId}|${email.toLowerCase()}`;

// The role as stored now. A session cookie lives 30 days, so the role it was
// minted with goes stale; re-reading here makes a demotion count within a
// minute. A user with no row is a learner.
export async function currentAppUserRole(tenantId: string, email: string, now = Date.now()): Promise<Role> {
  const key = roleKey(tenantId, email);
  const hit = roleCache.get(key);
  if (hit && now - hit.at < ROLE_TTL_MS) return hit.role;
  const role = asRole(await getAppUserRole(tenantId, email.toLowerCase()));
  if (roleCache.size >= 10_000) roleCache.clear();
  roleCache.set(key, { role, at: now });
  return role;
}

// Resolve the lms.AppUser row id for a signed-in admin/author. Returns null
// if onSessionCreated hasn't upserted the row yet (shouldn't happen for a
// staff session that has a resolved tenant).
export async function resolveAppUserId(
  tenantId: string,
  email: string,
): Promise<string | null> {
  const row = await queryOne<{ AppUserId: string }>(
    `SELECT CONVERT(varchar(64), AppUserId) AS AppUserId
       FROM lms.AppUser
      WHERE TenantId = @tenantId AND Email = @email`,
    { tenantId, email },
  );
  return row?.AppUserId ?? null;
}

export async function getAppUserRole(
  tenantId: string,
  email: string,
): Promise<string | null> {
  const row = await queryOne<{ Role: string }>(
    `SELECT Role FROM lms.AppUser
      WHERE TenantId = @tenantId AND Email = @email`,
    { tenantId, email },
  );
  return row?.Role ?? null;
}

export interface AppUserRow {
  AppUserId: string;
  Email: string;
  DisplayName: string;
  Role: string;
}

// Every identity in the tenant, ordered for display. Backs the course owner
// picker and the records roles list on /admin/records.
export async function listAppUsers(tenantId: string): Promise<AppUserRow[]> {
  return query<AppUserRow>(
    `SELECT CONVERT(varchar(64), AppUserId) AS AppUserId,
            Email, DisplayName, Role
       FROM lms.AppUser
      WHERE TenantId = @tenantId
      ORDER BY DisplayName ASC`,
    { tenantId },
  );
}

// An admin gives or takes away the instructor and training-manager roles
// (card d3e16430). Only a person whose stored role is learner, instructor or
// training manager moves, and only to one of those: an admin or an author is
// never changed here, and nobody becomes one. The change and its audit event
// are one transaction, so no role moves without a record of who moved it and
// from what.
export type RecordsRoleResult =
  | { outcome: "changed" | "unchanged"; role: RecordsRole; was: RecordsRole }
  | { outcome: "not_found" }
  | { outcome: "other_role"; role: string };

export const SET_RECORDS_ROLE = `
SET XACT_ABORT ON;
SET NOCOUNT ON;
BEGIN TRANSACTION;
DECLARE @was NVARCHAR(32), @email NVARCHAR(320), @changed BIT = 0;
SELECT @was = Role, @email = Email
  FROM lms.AppUser WITH (UPDLOCK, HOLDLOCK)
 WHERE TenantId = @tenantId AND AppUserId = @appUserId;
IF @was IN (N'learner', N'instructor', N'training_manager')
   AND @role IN (N'learner', N'instructor', N'training_manager')
   AND @was <> @role
BEGIN
  UPDATE lms.AppUser SET Role = @role WHERE TenantId = @tenantId AND AppUserId = @appUserId;
  INSERT INTO lms.AuditEvent (EventId, TenantId, Actor, Verb, ObjectKind, ObjectId, MetaJson)
  VALUES (NEWID(), @tenantId, @by, 'role.set', 'AppUser', LOWER(CONVERT(varchar(36), @appUserId)),
          CONCAT('{"from":"', @was, '","to":"', @role, '"}'));
  SET @changed = 1;
END;
COMMIT TRANSACTION;
SELECT @was AS Was, @email AS Email, @changed AS Changed;
`;

export async function setRecordsRole(
  tenantId: string,
  appUserId: string,
  role: RecordsRole,
  by: string,
): Promise<RecordsRoleResult> {
  const row = await queryOne<{ Was: string | null; Email: string | null; Changed: boolean | number }>(
    SET_RECORDS_ROLE,
    { tenantId, appUserId, role, by },
  );
  const was = row?.Was ?? null;
  if (was === null) return { outcome: "not_found" };
  const known = RECORDS_ROLES.find((r) => r === was.toLowerCase());
  if (!known) return { outcome: "other_role", role: was };
  const changed = row?.Changed === true || row?.Changed === 1;
  // This instance forgets the old role at once; another instance's cache
  // lets it stand for at most ROLE_TTL_MS.
  if (changed && row?.Email) roleCache.delete(roleKey(tenantId, row.Email));
  return { outcome: changed ? "changed" : "unchanged", role, was: known };
}

export async function resolveTenantIdForSession(who: BindingIdentity): Promise<string | null> {
  if (!who.tid) return null;
  const domain = who.email.split("@")[1]?.toLowerCase() ?? null;
  const rows = await query<TenantCandidate>(
    `SELECT t.TenantId, t.AadTenantId, d.Domain
       FROM lms.Tenant t
       LEFT JOIN lms.TenantDomain d ON d.TenantId = t.TenantId
       WHERE t.AadTenantId = @aadTid
          OR d.Domain = @domain`,
    { aadTid: who.tid, domain },
  );
  return chooseTenantBinding(rows, who);
}
