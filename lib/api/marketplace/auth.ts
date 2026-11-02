import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type { NextResponse } from "next/server";
import { recordError } from "@/lib/logging";
import { marketplaceError } from "./errors";

export type MarketplaceRole =
  | "Marketplace.Entitlements.Write"
  | "Marketplace.Catalogue.Read"
  | "Marketplace.Usage.Read";

// Pinned in code, not read from an app setting, so a settings change can never widen who may call.
export const FORIT_ENTRA_TENANT_ID = "c0efa09e-4bda-4a9d-a177-4c77076b7f76";

const ISSUERS = [
  `https://sts.windows.net/${FORIT_ENTRA_TENANT_ID}/`,
  `https://login.microsoftonline.com/${FORIT_ENTRA_TENANT_ID}/v2.0`,
];
const JWKS_URL = `https://login.microsoftonline.com/${FORIT_ENTRA_TENANT_ID}/discovery/v2.0/keys`;
const JWKS_TTL_MS = 60 * 60 * 1000;
const UNKNOWN_KID_REFETCH_MS = 5 * 60 * 1000;
const CLOCK_SKEW_S = 60;
const MAX_TOKEN_LENGTH = 16_000;
const JWT_SHAPE = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
// A header that names or embeds its own key would let the token choose what verifies it.
const KEY_SOURCE_HEADERS = ["jku", "x5u", "jwk", "x5c", "crit"];
const INVALID = "token is invalid, expired or not from the marketplace";

export type JwksFetcher = () => Promise<unknown>;
export type ErrorRecorder = (message: string) => Promise<unknown>;

export interface MarketplaceAuthDeps {
  fetchJwks?: JwksFetcher;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  recordError?: ErrorRecorder;
}

const recordApiError: ErrorRecorder = (message) => recordError("lms-api", message, "ERROR");

export interface MarketplaceCaller {
  appId: string;
  roles: string[];
}

export type MarketplaceCallerGate =
  | { ok: true; caller: MarketplaceCaller }
  | { ok: false; response: NextResponse };

type Json = Record<string, unknown>;

interface KeyCache {
  keys: Map<string, KeyObject>;
  fetchedAt: number;
  attemptedAt: number;
}

const caches = new WeakMap<JwksFetcher, KeyCache>();

function refusal(status: 401 | 403, code: string, description: string): MarketplaceCallerGate {
  const response = marketplaceError(status, code, description);
  response.headers.set("WWW-Authenticate", `Bearer realm="lms", error="${code}"`);
  return { ok: false, response };
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJson(segment: string): Json | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

async function fetchEntraJwks(): Promise<unknown> {
  // no-store: the cache below decides when keys refresh. A Next.js data cache
  // underneath would keep refusing tokens signed with a key Entra rotated in.
  const res = await fetch(JWKS_URL, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`JWKS fetch returned ${res.status}`);
  return res.json();
}

function importKeys(jwks: unknown): Map<string, KeyObject> {
  if (!isObject(jwks) || !Array.isArray(jwks.keys)) throw new Error("JWKS has no keys array");
  const keys = new Map<string, KeyObject>();
  for (const jwk of jwks.keys) {
    if (!isObject(jwk) || typeof jwk.kid !== "string" || jwk.kty !== "RSA") continue;
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    if (typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
    try {
      keys.set(jwk.kid, createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" }));
    } catch {
      continue;
    }
  }
  return keys;
}

async function refresh(cache: KeyCache, fetchJwks: JwksFetcher, at: number): Promise<void> {
  cache.attemptedAt = at;
  cache.keys = importKeys(await fetchJwks());
  cache.fetchedAt = at;
}

async function signingKey(kid: string, fetchJwks: JwksFetcher, at: number): Promise<KeyObject | undefined> {
  let cache = caches.get(fetchJwks);
  if (!cache) {
    cache = { keys: new Map(), fetchedAt: -Infinity, attemptedAt: -Infinity };
    caches.set(fetchJwks, cache);
  }
  if (at - cache.fetchedAt >= JWKS_TTL_MS) {
    await refresh(cache, fetchJwks, at);
  } else if (!cache.keys.has(kid) && at - cache.attemptedAt >= UNKNOWN_KID_REFETCH_MS) {
    await refresh(cache, fetchJwks, at);
  }
  return cache.keys.get(kid);
}

async function reportJwksFailure(err: unknown, record: ErrorRecorder): Promise<void> {
  try {
    await record(`marketplace.jwks: ${err instanceof Error ? err.message : String(err)}`);
  } catch {
    // Best effort: a logging outage must not turn the caller's 401 into a 500.
  }
}

async function verifiedPayload(
  token: string,
  fetchJwks: JwksFetcher,
  at: number,
  record: ErrorRecorder,
): Promise<Json | null> {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const [, rawHeader, rawPayload, rawSignature] = JWT_SHAPE.exec(token) ?? [];
  if (!rawHeader || !rawPayload || !rawSignature) return null;
  const header = decodeJson(rawHeader);
  const payload = decodeJson(rawPayload);
  if (!header || !payload) return null;
  const kid = header.kid;
  if (header.alg !== "RS256" || typeof kid !== "string" || kid === "") return null;
  if (KEY_SOURCE_HEADERS.some((name) => name in header)) return null;
  let key: KeyObject | undefined;
  try {
    key = await signingKey(kid, fetchJwks, at);
  } catch (err) {
    await reportJwksFailure(err, record);
    return null;
  }
  if (!key) return null;
  try {
    const signature = Buffer.from(rawSignature, "base64url");
    return verify("RSA-SHA256", Buffer.from(`${rawHeader}.${rawPayload}`), key, signature) ? payload : null;
  } catch {
    return null;
  }
}

function fromMarketplace(claims: Json, at: number, clientId: string, callerAppId: string): boolean {
  const nowS = at / 1000;
  const { exp, nbf, iss, aud, tid, idtyp } = claims;
  if (typeof exp !== "number" || nowS >= exp + CLOCK_SKEW_S) return false;
  if (nbf !== undefined && (typeof nbf !== "number" || nowS + CLOCK_SKEW_S < nbf)) return false;
  if (typeof iss !== "string" || !ISSUERS.includes(iss)) return false;
  const audiences = [clientId, `api://${clientId}`];
  const tokenAudiences: unknown[] = Array.isArray(aud) ? aud : [aud];
  if (!tokenAudiences.some((a) => typeof a === "string" && audiences.includes(a))) return false;
  if (tid !== FORIT_ENTRA_TENANT_ID) return false;
  if ((claims.appid ?? claims.azp) !== callerAppId) return false;
  if (idtyp !== undefined && idtyp !== "app") return false;
  // A delegated token carries scp; the marketplace calls as its own identity, never on a user's behalf.
  if (claims.scp !== undefined) return false;
  return true;
}

function bearerToken(req: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization")?.trim() ?? "");
  return match?.[1] ?? null;
}

export async function requireMarketplaceCaller(
  req: Request,
  role: MarketplaceRole,
  deps: MarketplaceAuthDeps = {},
): Promise<MarketplaceCallerGate> {
  const env = deps.env ?? process.env;
  const callerAppId = env.MARKETPLACE_CALLER_APP_ID;
  const clientId = env.AZURE_AD_CLIENT_ID;
  if (!callerAppId || !clientId) return refusal(401, "invalid_token", "marketplace caller not configured");

  const token = bearerToken(req);
  if (!token) return refusal(401, "invalid_token", "No authorization provided");
  if (token.startsWith("lms_")) {
    return refusal(401, "invalid_token", "tenant API keys cannot call marketplace routes");
  }

  const at = (deps.now?.() ?? new Date()).getTime();
  const claims = await verifiedPayload(token, deps.fetchJwks ?? fetchEntraJwks, at, deps.recordError ?? recordApiError);
  if (!claims || !fromMarketplace(claims, at, clientId, callerAppId)) {
    return refusal(401, "invalid_token", INVALID);
  }

  const roles = Array.isArray(claims.roles)
    ? claims.roles.filter((r): r is string => typeof r === "string")
    : [];
  if (!roles.includes(role)) return refusal(403, "insufficient_scope", `token lacks the ${role} app role`);
  return { ok: true, caller: { appId: callerAppId, roles } };
}
