// metered-call-guard: not-metered — the only host called here is forit-Auth
// (https://auth.forit.io), ForIT's own service; no per-call vendor charge.
// ============================================================================
// @foritllc/auth - Google sign-in adapter: forit-Auth session calls (0.13.0)
//
// Redeem, verify and revoke at https://auth.forit.io/api/v1/apps/{appId}/
// sessions (PR99 §4.1 to §4.3), with this app's `fau_` key, server to server.
// Each body is one small JSON object built only from the adapter's own values;
// a browser body is never forwarded. A redeem is never retried (PR99 §4.1: a
// second redeem of a code is a replay, and Auth revokes the first session).
//
// Every answer is checked against configuration before it counts, never
// against itself (consumer contract §4 step 4). Logs carry fixed text and a
// status number only: never a code, verifier, state, nonce or handle.
// ============================================================================

import { AUTH_ORIGIN, GOOGLE_ISSUER } from './google-config.js';
import type { DirectoryLink, GooglePrincipal } from './principal.js';
import { constantTimeEqual } from './oauth-transaction.js';

/** PR99 §3.4 code and §4.1 session handle: 43 base64url characters. */
export const OPAQUE_43 = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What the adapter knows about this app; every expected value comes from here. */
export interface ExchangeBinding {
  serviceKey: string;
  appId: string;
  workspaceHost: string;
  workspaceId: string;
  audience: string;
  callback: string;
  rpcTimeoutMs: number;
}

/** One call's outcome, by what the adapter does with it (contract §4 table). */
export type CallOutcome =
  | { kind: 'answer'; status: number; body: unknown }
  /** 503, a timeout or a network error: Auth is unavailable. */
  | { kind: 'unavailable'; status: number | null };

async function call(binding: ExchangeBinding, path: string, body: Record<string, string>): Promise<CallOutcome> {
  let res: Response;
  try {
    res = await fetch(`${AUTH_ORIGIN}/api/v1/apps/${binding.appId}/sessions${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${binding.serviceKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      // A redirect would carry the key somewhere else: refuse it.
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(binding.rpcTimeoutMs),
    });
  } catch {
    return { kind: 'unavailable', status: null };
  }
  if (res.status === 503) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: 'unavailable', status: 503 };
  }
  let parsed: unknown = null;
  try {
    const text = await res.text();
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { kind: 'answer', status: res.status, body: parsed };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseExpiry(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function label(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The GooglePrincipal in an Auth `identity` object, or null unless every check
 * passes: authClass `human-session`, provider `google` (a Microsoft identity is
 * refused, contract §1 item 7), the fixed issuer, this app's appId and
 * audience, the configured workspaceId, a subject, an expiry in the future,
 * and a directory, if present, with source `link`. Only the known fields are
 * copied, so nothing else Auth might send reaches the app.
 */
export function principalFromIdentity(
  identity: unknown,
  binding: Pick<ExchangeBinding, 'appId' | 'audience' | 'workspaceId'>,
  now = Date.now(),
): GooglePrincipal | null {
  if (!isObject(identity)) return null;
  if (identity.authClass !== 'human-session') return null;
  if (identity.provider !== 'google') return null;
  if (identity.issuer !== GOOGLE_ISSUER) return null;
  if (identity.appId !== binding.appId) return null;
  if (identity.audience !== binding.audience) return null;
  if (identity.workspaceId !== binding.workspaceId) return null;
  const subject = identity.subject;
  if (typeof subject !== 'string' || !subject || subject.length > 255 || /[\u0000-\u001f\u007f]/.test(subject)) {
    return null;
  }
  if (typeof identity.principalId !== 'string' || !identity.principalId) return null;
  if (typeof identity.sessionId !== 'string' || !identity.sessionId) return null;
  const expiresAt = parseExpiry(identity.expiresAt);
  if (expiresAt === null || expiresAt <= now) return null;

  let directory: DirectoryLink | undefined;
  if (identity.directory !== undefined && identity.directory !== null) {
    const d = identity.directory;
    if (
      !isObject(d) ||
      d.source !== 'link' ||
      typeof d.tenantId !== 'string' || !UUID.test(d.tenantId) ||
      typeof d.objectId !== 'string' || !UUID.test(d.objectId)
    ) {
      return null;
    }
    directory = Object.freeze({ tenantId: d.tenantId, objectId: d.objectId, source: 'link' as const });
  }

  const principal: GooglePrincipal = {
    provider: 'google',
    issuer: GOOGLE_ISSUER,
    subject,
    principalId: identity.principalId,
    workspaceId: binding.workspaceId,
    sessionId: identity.sessionId,
    appId: binding.appId,
    audience: binding.audience,
    displayName: label(identity.displayName),
    ...(directory ? { directory } : {}),
    expiresAt,
  };
  return Object.freeze(principal);
}

export type RedeemResult =
  | { ok: true; handle: string; expiresAt: number; principal: GooglePrincipal }
  | { ok: false; reason: 'refused' | 'unavailable' | 'bad_answer'; status: number | null };

/**
 * Redeem a code once. Success needs 201 with a 43-character `session`, a
 * future `expiresAt`, the nonce this browser's transaction sent, and an
 * identity that passes `principalFromIdentity`. Anything else is a failure.
 */
export async function redeemCode(
  binding: ExchangeBinding,
  code: string,
  codeVerifier: string,
  expectedNonce: string,
): Promise<RedeemResult> {
  const outcome = await call(binding, '', {
    code,
    code_verifier: codeVerifier,
    callback: binding.callback,
    workspaceHost: binding.workspaceHost,
  });
  if (outcome.kind === 'unavailable') {
    console.error('[forit/auth/google] redeem: forit-Auth unavailable', { status: outcome.status });
    return { ok: false, reason: 'unavailable', status: outcome.status };
  }
  if (outcome.status !== 201) {
    console.error('[forit/auth/google] redeem refused', { status: outcome.status });
    return { ok: false, reason: 'refused', status: outcome.status };
  }
  const body = outcome.body;
  const now = Date.now();
  const expiresAt = isObject(body) ? parseExpiry(body.expiresAt) : null;
  const principal = isObject(body) ? principalFromIdentity(body.identity, binding, now) : null;
  if (
    !isObject(body) ||
    typeof body.session !== 'string' || !OPAQUE_43.test(body.session) ||
    typeof body.nonce !== 'string' || !constantTimeEqual(body.nonce, expectedNonce) ||
    expiresAt === null || expiresAt <= now ||
    !principal
  ) {
    console.error('[forit/auth/google] redeem answer failed its checks', { status: 201 });
    return { ok: false, reason: 'bad_answer', status: 201 };
  }
  return { ok: true, handle: body.session, expiresAt: Math.min(expiresAt, principal.expiresAt), principal };
}

export type VerifyResult =
  | { kind: 'ok'; principal: GooglePrincipal }
  /** 401 invalid_session: the session has ended at Auth. */
  | { kind: 'ended' }
  /** 503, a timeout or a network error. */
  | { kind: 'unavailable'; status: number | null }
  /** Anything else: the app's configuration, its row at Auth or Auth's deploy is at fault. */
  | { kind: 'failed'; status: number | null };

/** Verify a handle. Nothing positive is kept past the caller's request (R-C1). */
export async function verifyHandle(binding: ExchangeBinding, handle: string): Promise<VerifyResult> {
  const outcome = await call(binding, '/verify', { session: handle });
  if (outcome.kind === 'unavailable') {
    console.error('[forit/auth/google] verify: forit-Auth unavailable', { status: outcome.status });
    return { kind: 'unavailable', status: outcome.status };
  }
  if (outcome.status === 200) {
    const principal = isObject(outcome.body) ? principalFromIdentity(outcome.body.identity, binding) : null;
    if (principal) return { kind: 'ok', principal };
    console.error('[forit/auth/google] verify answer failed its checks', { status: 200 });
    return { kind: 'failed', status: 200 };
  }
  if (outcome.status === 401 && isObject(outcome.body) && outcome.body.error === 'invalid_session') {
    return { kind: 'ended' };
  }
  console.error('[forit/auth/google] verify refused', { status: outcome.status });
  return { kind: 'failed', status: outcome.status };
}

/** Revoke a handle. True only on 204; any other answer may leave it live at Auth until it expires. */
export async function revokeHandle(binding: ExchangeBinding, handle: string): Promise<boolean> {
  const outcome = await call(binding, '/revoke', { session: handle });
  const status = outcome.status;
  if (outcome.kind === 'answer' && status === 204) return true;
  console.error('[forit/auth/google] revoke not confirmed; the session may stay live at forit-Auth until it expires', {
    status,
  });
  return false;
}
