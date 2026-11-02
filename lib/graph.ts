import "server-only";
import { isServiceAccount } from "@/lib/service-account";

// Graph helpers for sign-in flows: app-only client-credentials token plus a
// transitive-group lookup. App-only because the user-delegated token issued
// by @foritllc/auth carries only `User.Read` and can't enumerate group
// membership. Requires the LMS app reg to be granted `GroupMember.Read.All`
// (Application permission, admin consent) — without it the call returns 403
// and the caller falls back to default role/curricula.

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cached: CachedToken | null = null;

async function fetchAppToken(): Promise<string | null> {
  // Managed Identity first (App Service production), then service principal
  // (local dev). Same shape as lib/dns/azure.ts:getAzureToken, just a
  // different audience.
  const msiEndpoint = process.env.IDENTITY_ENDPOINT;
  const msiHeader = process.env.IDENTITY_HEADER;
  if (msiEndpoint && msiHeader) {
    try {
      const res = await fetch(
        `${msiEndpoint}?api-version=2019-08-01&resource=https://graph.microsoft.com/`,
        { headers: { "X-IDENTITY-HEADER": msiHeader } },
      );
      if (res.ok) {
        const data = (await res.json()) as {
          access_token: string;
          expires_in?: number;
        };
        cached = {
          token: data.access_token,
          expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 300_000,
        };
        return data.access_token;
      }
    } catch {
      /* fall through */
    }
  }

  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  const tenantId = process.env.AZURE_TENANT_ID;
  if (!clientId || !clientSecret || !tenantId) return null;

  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }),
    },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as {
    access_token: string;
    expires_in?: number;
  };
  cached = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 300_000,
  };
  return data.access_token;
}

async function getAppToken(): Promise<string | null> {
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  return fetchAppToken();
}

export interface LicensedUser {
  aadOid: string;
  email: string;
  displayName: string;
}

// Lists every licensed, enabled AAD user. Powers the daily-digest blast and
// the learner-sync endpoint. Requires the LMS app reg to have
// `User.Read.All` (Application permission, admin consent). Empty array on
// 403/missing perm — caller MUST treat as "no roster," never as "deny" or
// "send to nobody silently."
//
// Filter is enabled-only; assignedLicenses is filtered app-side because
// `assignedLicenses/$count gt 0` is rejected by Graph as
// Request_UnsupportedQuery (the `Greater` operator isn't valid against
// collection-valued nav props here). Page size 999 + @odata.nextLink for
// tenants past that.
export async function listLicensedUsers(): Promise<LicensedUser[]> {
  const token = await getAppToken();
  if (!token) return [];

  const users: LicensedUser[] = [];
  let url:
    | string
    | undefined = `https://graph.microsoft.com/v1.0/users?$filter=accountEnabled%20eq%20true&$select=id,mail,displayName,userPrincipalName,assignedLicenses&$top=999`;

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.warn(
        `[lib/graph] listLicensedUsers failed: HTTP ${res.status}`,
      );
      return users;
    }
    const page = (await res.json()) as {
      value: Array<{
        id: string;
        mail: string | null;
        displayName: string | null;
        userPrincipalName: string | null;
        assignedLicenses?: Array<{ skuId: string }>;
      }>;
      "@odata.nextLink"?: string;
    };
    for (const u of page.value) {
      if (!u.assignedLicenses || u.assignedLicenses.length === 0) continue;
      const email = u.mail ?? u.userPrincipalName;
      if (!email) continue;
      if (isServiceAccount(email)) continue;
      users.push({
        aadOid: u.id,
        email,
        displayName: u.displayName ?? email,
      });
    }
    url = page["@odata.nextLink"];
  }
  return users;
}

// Fetches a user's directory profile photo app-only from Microsoft Graph.
// Returns null on 404 (the very common "user has no photo" case), on a
// missing app token, or on any error — callers MUST treat null as "no photo,
// fall back to initials," never as a hard failure. Requires the LMS app reg
// to have `User.Read.All` (Application permission, admin consent), the same
// grant listLicensedUsers already relies on; /photo/$value works under it.
export async function getUserPhoto(
  oid: string,
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  const token = await getAppToken();
  if (!token) return null;

  try {
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(oid)}/photo/$value`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    return {
      bytes: await res.arrayBuffer(),
      contentType: res.headers.get("content-type") ?? "image/jpeg",
    };
  } catch {
    return null;
  }
}

// Returns every group id the user belongs to, including nested groups. Empty
// array on missing permission / failure — callers MUST treat that as "no
// special memberships" and fall back to defaults, never as "deny".
export async function getTransitiveGroupIds(
  azureOid: string,
): Promise<string[]> {
  const token = await getAppToken();
  if (!token) return [];

  const ids: string[] = [];
  let url:
    | string
    | undefined = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(azureOid)}/transitiveMemberOf/microsoft.graph.group?$select=id&$top=999`;

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      // Most likely 403 (missing admin consent for GroupMember.Read.All).
      // Don't throw — sign-in should still succeed without group-driven role.
      console.warn(
        `[lib/graph] transitiveMemberOf failed for ${azureOid}: HTTP ${res.status}`,
      );
      return ids;
    }
    const page = (await res.json()) as {
      value: Array<{ id: string }>;
      "@odata.nextLink"?: string;
    };
    for (const g of page.value) ids.push(g.id);
    url = page["@odata.nextLink"];
  }
  return ids;
}
