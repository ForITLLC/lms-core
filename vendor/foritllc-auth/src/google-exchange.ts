// metered-call-guard: not-metered — the only host called here is forit-Auth
// (https://auth.forit.io), ForIT's own service; no per-call vendor charge.
// ============================================================================
// @foritllc/auth - Google sign-in adapter: forit-Auth session calls (0.13.0, 0.18.0)
//
// Redeem, verify and revoke at https://auth.forit.io/api/v1/apps/{appId}/
// sessions (PR99 §4.1 to §4.3), server to server, with this app's `fau_` key
// or (0.18.0) a token from its own managed identity. Identity mode gets the
// token before the request; with no token it sends nothing, and it never
// falls back to a key.
// Each body is one small JSON object built only from the adapter's own values;
// a browser body is never forwarded. A redeem is never retried (PR99 §4.1: a
// second redeem of a code is a replay, and Auth revokes the first session).
//
// Every answer is checked against configuration before it counts, never
// against itself (consumer contract §4 step 4). Logs carry fixed text and a
// status number only: never a code, verifier, state, nonce or handle.
// ============================================================================

import { AuthCallerTokenError, type AuthCallerTokenErrorCode } from './client-assertion.js';
import { AUTH_ORIGIN, GOOGLE_ISSUER } from './google-config.js';
import { type DirectoryLink, type GooglePrincipal, parseDirectoryLink, sameDirectoryLink } from './principal.js';
import { constantTimeEqual } from './oauth-transaction.js';

/** PR99 §3.4 code and §4.1 session handle: 43 base64url characters. */
export const OPAQUE_43 = /^[A-Za-z0-9_-]{43}$/;

/** How this app proves itself to Auth: its `fau_` key, or a managed identity token source (0.18.0). */
export type ExchangeProof =
  | { kind: 'key'; serviceKey: string }
  | { kind: 'identity'; token: () => Promise<string> };

/** What the adapter knows about this app; every expected value comes from here. */
export interface ExchangeBinding {
  proof: ExchangeProof;
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
  /** 503, a timeout or a network error, before or during the body: Auth is unavailable. */
  | { kind: 'unavailable'; status: number | null }
  /** 0.18.0, identity mode: no managed identity token, so nothing was sent to Auth. */
  | { kind: 'no_caller'; retryable: boolean; code: AuthCallerTokenErrorCode };

async function call(binding: ExchangeBinding, path: string, body: Record<string, string>): Promise<CallOutcome> {
  // The key is used as it is, with no await before the request (the 0.17.0
  // path, unchanged). A token comes first; without one, no request is made.
  let bearer: string;
  if (binding.proof.kind === 'key') {
    bearer = binding.proof.serviceKey;
  } else {
    try {
      bearer = await binding.proof.token();
    } catch (error) {
      const known = error instanceof AuthCallerTokenError;
      return {
        kind: 'no_caller',
        retryable: known && error.retryable,
        code: known ? error.code : 'AUTH_CALLER_TOKEN_UNAVAILABLE',
      };
    }
  }
  let res: Response;
  try {
    res = await fetch(`${AUTH_ORIGIN}/api/v1/apps/${binding.appId}/sessions${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      // A redirect would carry the key or token somewhere else: refuse it.
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
  let text: string;
  try {
    text = await res.text();
  } catch {
    // The status line came back but the body did not: the rpcTimeoutMs signal
    // fired part way through it, or the connection dropped. That is no answer,
    // so Auth is unavailable (contract §4 answer table), not a generic failure.
    return { kind: 'unavailable', status: null };
  }
  let parsed: unknown = null;
  try {
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
 * 0.24.0. The link's target from one Auth `identity`: the link, `undefined` for
 * none, or `false` to refuse the whole answer (for-Auth DBECB392,
 * for-Architecture A969B4BE G1).
 *
 * - `target` (new on verify) is always labelled: `{ kind: 'directory-person',
 *   partitionId, personId, source }` or the `entra-object` shape. It is read
 *   when present, and an unlabelled `target` is refused.
 * - `directory` is today's field, byte-identical for an Entra object with no
 *   `kind`, and null or absent for a Directory person. With no `target`, an
 *   unlabelled `directory` still reads as an Entra object, exactly as 0.23.x
 *   did. A Directory person arrives only in `target`, so a person in
 *   `directory` is refused.
 * - When both are present they must name the same target (kind, ids and
 *   source); any disagreement refuses.
 * - Ids exactly as Auth sends them (lower case). Anything `parseDirectoryLink`
 *   cannot place (an unknown label, a person with no label, both shapes, a
 *   source not listed) refuses the whole answer, as a malformed link always has.
 */
function linkOf(identity: Record<string, unknown>): DirectoryLink | undefined | false {
  const present = (value: unknown) => value !== undefined && value !== null;
  const target = present(identity.target) ? parseDirectoryLink(identity.target, { labelled: true }) : undefined;
  const directory = present(identity.directory) ? parseDirectoryLink(identity.directory) : undefined;
  if (target === null || directory === null) return false;
  if (directory?.kind === 'directory-person') return false;
  if (target && directory && !sameDirectoryLink(target, directory)) return false;
  return target ?? directory;
}

/**
 * The GooglePrincipal in an Auth `identity` object, or null unless every check
 * passes: authClass `human-session`, provider `google` (a Microsoft identity is
 * refused, contract §1 item 7), the fixed issuer, this app's appId and
 * audience, the configured workspaceId, a subject, an expiry in the future,
 * and the link's target, if any, placed exactly (`linkOf`). Only the known
 * fields are copied, so nothing else Auth might send reaches the app.
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

  const directory = linkOf(identity);
  if (directory === false) return null;

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
  if (outcome.kind === 'no_caller') {
    // Nothing was sent, so the code is unspent; it is still never retried here.
    console.error('[forit/auth/google] redeem: no Auth caller token; nothing was sent', {
      code: outcome.code,
      retryable: outcome.retryable,
    });
    return { ok: false, reason: outcome.retryable ? 'unavailable' : 'refused', status: null };
  }
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
  if (outcome.kind === 'no_caller') {
    // Neither clears the cookie: the session itself may be fine.
    console.error('[forit/auth/google] verify: no Auth caller token; nothing was sent', {
      code: outcome.code,
      retryable: outcome.retryable,
    });
    return outcome.retryable ? { kind: 'unavailable', status: null } : { kind: 'failed', status: null };
  }
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
  if (outcome.kind === 'no_caller') {
    console.error(
      '[forit/auth/google] revoke: no Auth caller token; nothing was sent, and the session may stay live at forit-Auth until it expires',
      { code: outcome.code, retryable: outcome.retryable },
    );
    return false;
  }
  const status = outcome.status;
  if (outcome.kind === 'answer' && status === 204) return true;
  console.error('[forit/auth/google] revoke not confirmed; the session may stay live at forit-Auth until it expires', {
    status,
  });
  return false;
}
