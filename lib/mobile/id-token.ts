import { IdTokenError, validateIdToken } from "@foritllc/auth";

// The ForIT LMS iPhone app signs in through ForIT Sign-in, the shared public
// client (auth code + PKCE, openid profile email; for-Common
// docs/patterns/forit-sign-in-client.md, native rules 1-3). It posts the
// id_token once to POST /api/mobile/token, which validates it here.
//
// @foritllc/auth validateIdToken checks signature, issuer (.../<tid>/v2.0),
// audience, expiry and nonce. The LMS is white-label, so there is no tid pin:
// which LMS tenant a user lands in is decided afterwards by the same tid-first
// binding as the web callback (lib/auth/tenant-binding.ts). Native rule 2: a
// B2B guest is refused, because a guest's token carries the resource tenant's
// tid; Entra puts the guest's home directory in `idp`.

export const FORIT_SIGNIN_CLIENT_ID =
  process.env.FORIT_SIGNIN_CLIENT_ID || "";

const MAX_ID_TOKEN_LENGTH = 16 * 1024;

export class MobileTokenError extends Error {
  constructor(
    readonly reason: string,
    readonly status: 400 | 401 | 403 | 503,
  ) {
    super(`id_token rejected: ${reason}`);
    this.name = "MobileTokenError";
  }
}

export interface MobileIdentity {
  tid: string;
  iss: string;
  oid: string;
  name: string;
  // The member's UPN (preferred_username): its domain must be one the user's
  // own tenant has verified, so it is the mobile equivalent of the web
  // callback's Graph userPrincipalName. The free-text `email` claim is only a
  // fallback label and is never marked verified.
  email: string;
  emailVerified: boolean;
}

function address(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(s) ? s : null;
}

export function homeIdp(tid: string): string {
  return `https://sts.windows.net/${tid}/`;
}

/** Post-signature checks on a validated id_token's claims. */
export function identityFromClaims(claims: Record<string, unknown>): MobileIdentity {
  const tid = typeof claims.tid === "string" ? claims.tid.toLowerCase() : "";
  const iss = typeof claims.iss === "string" ? claims.iss : "";
  if (!tid || !iss) throw new MobileTokenError("tenant", 401);
  if (Object.prototype.hasOwnProperty.call(claims, "idp") && claims.idp !== homeIdp(tid)) {
    throw new MobileTokenError("guest", 403);
  }
  const oid = typeof claims.oid === "string" ? claims.oid.toLowerCase() : "";
  if (!oid) throw new MobileTokenError("oid", 401);

  const upn = address(claims.preferred_username);
  const email = upn ?? address(claims.email);
  if (!email) throw new MobileTokenError("email", 401);
  if (/#ext#@/i.test(email)) throw new MobileTokenError("guest", 403);

  const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : email;
  return { tid, iss, oid, name, email, emailVerified: upn !== null };
}

export async function validateMobileIdToken(
  idToken: unknown,
  nonce: unknown,
  now = Date.now(),
): Promise<MobileIdentity> {
  if (typeof idToken !== "string" || !idToken) throw new MobileTokenError("missing", 400);
  if (idToken.length > MAX_ID_TOKEN_LENGTH) throw new MobileTokenError("malformed", 400);
  if (typeof nonce !== "string" || !nonce) throw new MobileTokenError("nonce", 400);

  let claims: Record<string, unknown>;
  try {
    claims = await validateIdToken(idToken, { clientId: FORIT_SIGNIN_CLIENT_ID, nonce }, now);
  } catch (error) {
    if (!(error instanceof IdTokenError)) throw error;
    const status = error.upstreamStatus;
    if (
      error.reason.startsWith("signing keys unavailable") &&
      (status === undefined || status === 429 || status >= 500)
    ) {
      throw new MobileTokenError("signing_keys_unavailable", 503);
    }
    throw new MobileTokenError(error.reason, 401);
  }
  return identityFromClaims(claims);
}
