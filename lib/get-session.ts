import { cache } from "react";
import { headers } from "next/headers";
import { createGetSession } from "@foritllc/auth";
import { recordError } from "@/lib/logging";
import { authConfig, type LmsSession } from "@/lib/auth-config";
import { hasDeviceKeyShape, sessionForDeviceKey } from "@/lib/db/mobileKeys";
import { currentAppUserRole } from "@/lib/db/users";

// Thin wrapper around @foritllc/auth. The session is read from the
// HMAC-signed `forit_lms_session_v2` cookie minted by the auth callback. The
// signatures (getSessionUser / requireSessionUser / getTenantId) match the
// prior Easy Auth shim so downstream callers don't change.
const _getSession = createGetSession(authConfig);

// `cache` dedupes within a request: pages and the components they render can
// each call getSessionUser() without re-parsing the HMAC cookie or
// re-verifying the signature.
//
// The iPhone app has no cookie: it sends its lmk_ device key (minted by
// POST /api/mobile/token, lib/db/mobileKeys.ts) as a Bearer token. The
// middleware still gates every cookie-protected path, so in practice a device
// key only authenticates the public /api/mobile routes.
export const getSessionUser = cache(async (): Promise<LmsSession | null> => {
  const s = await _getSession();
  if (s) return withCurrentRole(s as unknown as LmsSession);
  const key = await deviceKeyFromRequest();
  const device = key ? await deviceKeySession(key) : null;
  return device ? withCurrentRole(device) : null;
});

// The role inside a 30-day cookie or a device key is only what it was at
// sign-in; the lms.AppUser row decides. A failed read answers learner, so an
// outage never leaves a demoted user with staff access.
async function withCurrentRole(session: LmsSession): Promise<LmsSession> {
  if (!session.tenantId) return session;
  try {
    return { ...session, role: await currentAppUserRole(session.tenantId, session.email) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordError("lms-api", `session.role: ${message}`, "ERROR").catch(() => undefined);
    return { ...session, role: "learner" };
  }
}

// A key the lookup can't check (database down, lms.MobileDeviceKey missing)
// fails closed: the caller answers 401, never a 500, and the error is logged.
async function deviceKeySession(key: string): Promise<LmsSession | null> {
  try {
    return await sessionForDeviceKey(key);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordError("lms-api", `mobile.deviceKey: ${message}`, "ERROR").catch(() => undefined);
    return null;
  }
}

async function deviceKeyFromRequest(): Promise<string | null> {
  let header: string | null = null;
  try {
    header = (await headers()).get("authorization");
  } catch {
    return null;
  }
  const token = header ? /^Bearer\s+(\S+)$/i.exec(header.trim())?.[1] : undefined;
  return hasDeviceKeyShape(token) ? token : null;
}

export async function requireSessionUser(): Promise<LmsSession> {
  const u = await getSessionUser();
  if (!u) throw new Error("UNAUTHENTICATED");
  return u;
}

export async function getTenantId(): Promise<string | null> {
  return (await getSessionUser())?.tenantId ?? null;
}

export type { LmsSession, Role } from "@/lib/auth-config";
