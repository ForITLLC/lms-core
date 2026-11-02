import { NextResponse } from "next/server";
import type { BaseSession } from "@foritllc/auth";
import { recordError } from "@/lib/logging";
import { bindLmsSession } from "@/lib/auth-config-server";
import { bearerFrom } from "@/lib/api/bearer";
import { mintDeviceKey, revokeDeviceKey } from "@/lib/db/mobileKeys";
import { MobileTokenError, validateMobileIdToken } from "@/lib/mobile/id-token";
import { mobileProfile } from "@/lib/mobile/profile";
import type { Role } from "@/lib/auth-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The iPhone app's one sign-in call (for-Common forit-sign-in-client.md, native
// apps). Body: { id_token, nonce, device_name? } from ForIT Sign-in. The token
// is validated (lib/mobile/id-token.ts), the LMS tenant is bound by the same
// bindLmsSession as the web callback, and a 30-day lmk_ device key is returned
// once. A user whose organisation maps to no LMS tenant gets 409 no_tenant and
// no key, so an unbound device never holds a credential.
export async function POST(req: Request): Promise<NextResponse> {
  let body: { id_token?: unknown; nonce?: unknown; device_name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const who = await validateMobileIdToken(body.id_token, body.nonce);
    const base: BaseSession = {
      email: who.email,
      emailVerified: who.emailVerified,
      isGuest: false,
      name: who.name,
      azureOid: who.oid,
      tid: who.tid,
      iss: who.iss,
      expiresAt: Date.now(),
    };
    const bound = await bindLmsSession(base);
    if (!bound.tenantId) {
      console.warn("[LMS-MOBILE] no tenant for sign-in", { tid: who.tid, domain: who.email.split("@")[1] });
      return NextResponse.json(
        { error: "no_tenant", message: "Your organisation isn't set up for learning yet." },
        { status: 409 },
      );
    }
    const role = (bound.role ?? "learner") as Role;
    const deviceName = typeof body.device_name === "string" ? body.device_name.trim() : "";
    const minted = await mintDeviceKey({
      tenantId: bound.tenantId,
      email: who.email,
      name: who.name,
      azureOid: who.oid,
      tid: who.tid,
      iss: who.iss,
      role,
      groups: bound.groups ?? [],
      deviceName: deviceName || null,
    });
    const profile = await mobileProfile({
      tenantId: bound.tenantId,
      email: who.email,
      name: who.name,
      role,
    });
    return NextResponse.json(
      { key: minted.key, expires_at: minted.expiresAt.toISOString(), ...profile },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof MobileTokenError) {
      console.warn("[LMS-MOBILE] token refused", { reason: err.reason });
      return NextResponse.json({ error: err.reason }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : String(err);
    await recordError("lms-api", `mobile.token: ${message}`, "ERROR").catch(() => undefined);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

// Sign-out: the app revokes its own key. Unknown keys answer 204 too, so the
// call says nothing about which keys exist.
export async function DELETE(req: Request): Promise<Response> {
  const key = bearerFrom(req);
  if (key) {
    await revokeDeviceKey(key).catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      await recordError("lms-api", `mobile.token.revoke: ${message}`, "ERROR").catch(() => undefined);
    });
  }
  return new Response(null, { status: 204 });
}
