// metered-call-guard: not-metered — the only host called here is forit-Auth
// (https://auth.forit.io), ForIT's own service; no per-call vendor charge.
// ============================================================================
// @foritllc/auth - Microsoft sign-in adapter: forit-Auth session calls
//
// Redeem, verify and revoke at https://auth.forit.io/api/v1/apps/{appId}/
// sessions, server to server, with this app's `fau_` key or a token from its
// own managed identity. These are the same three endpoints the Google adapter
// calls (google-exchange.ts); `call()` below mirrors its private `call()`,
// which that file does not export. Nothing here calls a Google function.
//
// Each body is one small JSON object built only from the adapter's own values;
// a browser body is never forwarded. A redeem is NEVER retried, whatever came
// back: a timeout, a dropped body and a 5xx may all have spent the code, and a
// second redeem of a spent code is a replay that makes Auth revoke the session
// the first one created.
//
// Every answer is checked against configuration before it counts, never
// against itself. The identity forit-Auth sends is trusted only as the direct
// answer of this fixed-origin call; it is not a portable token. Logs carry
// fixed text and a status number only: never a code, verifier, state, nonce,
// handle, token or cookie value.
// ============================================================================

import { AuthCallerTokenError, type AuthCallerTokenErrorCode } from './client-assertion.js';
import { AUTH_ORIGIN } from './google-config.js';
import { OPAQUE_43 } from './google-exchange.js';
import { CANONICAL_GUID, type MicrosoftPrincipal } from './microsoft-config.js';
import { constantTimeEqual } from './oauth-transaction.js';

/** How this app proves itself to Auth: its `fau_` key, or a managed identity token source. Backend only. */
export type MicrosoftExchangeProof =
  | { kind: 'key'; serviceKey: string }
  | { kind: 'identity'; token: () => Promise<string> };

/** What the adapter knows about this app; every expected value comes from here. */
export interface MicrosoftExchangeBinding {
  proof: MicrosoftExchangeProof;
  appId: string;
  workspaceHost: string;
  workspaceId: string;
  audience: string;
  callback: string;
  /** The one Entra tenant, a canonical lower-case GUID. */
  tenantId: string;
  /** The exact issuer expected in every answer. */
  issuer: string;
  rpcTimeoutMs: number;
}

/** One call's outcome, by what the adapter does with it. Mirrors google-exchange.ts CallOutcome. */
type CallOutcome =
  | { kind: 'answer'; status: number; body: unknown }
  /** 503, a timeout or a network error, before or during the body: Auth is unavailable. */
  | { kind: 'unavailable'; status: number | null }
  /** Identity mode: no managed identity token, so nothing was sent to Auth. */
  | { kind: 'no_caller'; retryable: boolean; code: AuthCallerTokenErrorCode };

/** Longest `principalId` or `sessionId` accepted: both are bound into the session cookie. */
const MAX_ID_LENGTH = 128;
const CONTROL = /[\u0000-\u001f\u007f]/;

// Mirrors google-exchange.ts call(): one POST, no redirect, no cache, one timeout, no retry.
async function call(binding: MicrosoftExchangeBinding, path: string, body: Record<string, string>): Promise<CallOutcome> {
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
    // The status line came back but the body did not: that is no answer.
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

/** A non-empty id of at most 128 characters with no control character, exactly as sent; else null. */
function publicId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && !CONTROL.test(value)
    ? value
    : null;
}

/**
 * The person's tenant and object id from `identity.directory`, or null.
 *
 * REQUIRED for a Microsoft identity, and `source` must be exactly `token`:
 * forit-Auth read the ids from the person's own validated Microsoft token. A
 * `link` source (a custodian-made link, the Google case) is not a Microsoft
 * sign-in and is refused. Both ids must already be canonical lower-case GUIDs,
 * as Auth sends them; nothing is folded. A person-shaped field, or a label
 * other than `entra-object`, refuses.
 */
function directoryOf(raw: unknown): { tenantId: string; objectId: string } | null {
  if (!isObject(raw)) return null;
  if (raw.source !== 'token') return null;
  if (raw.kind !== undefined && raw.kind !== 'entra-object') return null;
  if (raw.partitionId !== undefined || raw.personId !== undefined) return null;
  const { tenantId, objectId } = raw;
  if (typeof tenantId !== 'string' || !CANONICAL_GUID.test(tenantId)) return null;
  if (typeof objectId !== 'string' || !CANONICAL_GUID.test(objectId)) return null;
  return { tenantId, objectId };
}

/**
 * True when a PRESENT `identity.target` is the labelled Entra object that
 * `directory` names: `kind` exactly `entra-object`, `source` exactly `token`,
 * and the same tenantId and objectId. Anything else that is present refuses
 * the whole answer: a Directory-person target, an unlabelled one, one that
 * disagrees, a malformed one and `null`. (The Google exchange reads a null
 * target as absent; here only a missing key is absent.) The target is never
 * placed on the principal.
 */
function targetAgrees(raw: unknown, directory: { tenantId: string; objectId: string }): boolean {
  if (!isObject(raw)) return false;
  if (raw.kind !== 'entra-object') return false;
  if (raw.partitionId !== undefined || raw.personId !== undefined) return false;
  return raw.source === 'token' && raw.tenantId === directory.tenantId && raw.objectId === directory.objectId;
}

/**
 * The MicrosoftPrincipal in an Auth `identity` object, or null unless every
 * check passes:
 *
 * - authClass `human-session`; provider `microsoft` (a Google identity is refused);
 * - issuer exactly the configured issuer;
 * - this app's appId and audience, and the configured workspaceId;
 * - subject a canonical lower-case GUID (the Entra `oid`);
 * - `directory` present, source `token`, its tenantId the configured tenantId
 *   and its objectId equal to the subject;
 * - principalId and sessionId non-empty (the Google rule), at most 128
 *   characters and free of control characters (both go into the cookie);
 * - expiresAt a valid instant in the future;
 * - `target`, when present, the same Entra object (`targetAgrees`).
 *
 * Only the known fields are copied. An email, a hosted domain, a guest or
 * staff flag, groups, `authUserId` or anything else Auth might send is not
 * read and never reaches the app.
 */
export function microsoftPrincipalFromIdentity(
  identity: unknown,
  binding: Pick<MicrosoftExchangeBinding, 'appId' | 'audience' | 'workspaceId' | 'tenantId' | 'issuer'>,
  now = Date.now(),
): MicrosoftPrincipal | null {
  if (!isObject(identity)) return null;
  if (identity.authClass !== 'human-session') return null;
  if (identity.provider !== 'microsoft') return null;
  if (identity.issuer !== binding.issuer) return null;
  if (identity.appId !== binding.appId) return null;
  if (identity.audience !== binding.audience) return null;
  if (identity.workspaceId !== binding.workspaceId) return null;
  const subject = identity.subject;
  if (typeof subject !== 'string' || !CANONICAL_GUID.test(subject)) return null;

  const directory = directoryOf(identity.directory);
  if (!directory) return null;
  if (directory.tenantId !== binding.tenantId) return null;
  if (directory.objectId !== subject) return null;

  const principalId = publicId(identity.principalId);
  const sessionId = publicId(identity.sessionId);
  if (principalId === null || sessionId === null) return null;
  const expiresAt = parseExpiry(identity.expiresAt);
  if (expiresAt === null || expiresAt <= now) return null;

  if (identity.target !== undefined && !targetAgrees(identity.target, directory)) return null;

  const principal: MicrosoftPrincipal = {
    provider: 'microsoft',
    issuer: binding.issuer,
    tenantId: directory.tenantId,
    objectId: directory.objectId,
    subject,
    principalId,
    workspaceId: binding.workspaceId,
    sessionId,
    displayName: label(identity.displayName),
    expiresAt,
  };
  return Object.freeze(principal);
}

export type MicrosoftRedeemResult =
  | { ok: true; handle: string; expiresAt: number; principal: MicrosoftPrincipal }
  | {
      ok: false;
      reason: 'refused' | 'unavailable' | 'bad_answer';
      status: number | null;
      /**
       * Only on `bad_answer`: the well-shaped handle of the session Auth just
       * created with an answer that failed its checks. The callback revokes
       * it; it is never put in a cookie.
       */
      handle?: string;
    };

/**
 * Redeem a code once. Success needs 201 with a 43-character `session`, a
 * future `expiresAt` that EQUALS `identity.expiresAt` (Auth's contract), the
 * nonce this browser's transaction sent (compared in constant time), and an
 * identity that passes `microsoftPrincipalFromIdentity`. Anything else is a
 * failure, and no failure is retried.
 */
export async function redeemMicrosoftCode(
  binding: MicrosoftExchangeBinding,
  code: string,
  codeVerifier: string,
  expectedNonce: string,
): Promise<MicrosoftRedeemResult> {
  const outcome = await call(binding, '', {
    code,
    code_verifier: codeVerifier,
    callback: binding.callback,
    workspaceHost: binding.workspaceHost,
  });
  if (outcome.kind === 'no_caller') {
    // Nothing was sent, so the code is unspent; it is still never retried here.
    console.error('[forit/auth/microsoft] redeem: no Auth caller token; nothing was sent', {
      code: outcome.code,
      retryable: outcome.retryable,
    });
    return { ok: false, reason: outcome.retryable ? 'unavailable' : 'refused', status: null };
  }
  if (outcome.kind === 'unavailable') {
    console.error('[forit/auth/microsoft] redeem: forit-Auth unavailable; not retried', { status: outcome.status });
    return { ok: false, reason: 'unavailable', status: outcome.status };
  }
  if (outcome.status !== 201) {
    console.error('[forit/auth/microsoft] redeem refused', { status: outcome.status });
    return { ok: false, reason: 'refused', status: outcome.status };
  }
  const body = outcome.body;
  const now = Date.now();
  const handle = isObject(body) && typeof body.session === 'string' && OPAQUE_43.test(body.session) ? body.session : null;
  const expiresAt = isObject(body) ? parseExpiry(body.expiresAt) : null;
  const principal = isObject(body) ? microsoftPrincipalFromIdentity(body.identity, binding, now) : null;
  if (
    !isObject(body) ||
    handle === null ||
    typeof body.nonce !== 'string' || !constantTimeEqual(body.nonce, expectedNonce) ||
    expiresAt === null || expiresAt <= now ||
    !principal ||
    expiresAt !== principal.expiresAt
  ) {
    console.error('[forit/auth/microsoft] redeem answer failed its checks', { status: 201 });
    return { ok: false, reason: 'bad_answer', status: 201, ...(handle !== null ? { handle } : {}) };
  }
  return { ok: true, handle, expiresAt, principal };
}

export type MicrosoftVerifyResult =
  | { kind: 'ok'; principal: MicrosoftPrincipal }
  /** 401 invalid_session: the session has ended at Auth. */
  | { kind: 'ended' }
  /** 503, a timeout or a network error. */
  | { kind: 'unavailable'; status: number | null }
  /** Anything else: the app's configuration, its row at Auth or Auth's deploy is at fault. */
  | { kind: 'failed'; status: number | null };

/** Verify a handle. Nothing positive is kept past the caller's request. */
export async function verifyMicrosoftHandle(binding: MicrosoftExchangeBinding, handle: string): Promise<MicrosoftVerifyResult> {
  const outcome = await call(binding, '/verify', { session: handle });
  if (outcome.kind === 'no_caller') {
    // Neither clears the cookie: the session itself may be fine.
    console.error('[forit/auth/microsoft] verify: no Auth caller token; nothing was sent', {
      code: outcome.code,
      retryable: outcome.retryable,
    });
    return outcome.retryable ? { kind: 'unavailable', status: null } : { kind: 'failed', status: null };
  }
  if (outcome.kind === 'unavailable') {
    console.error('[forit/auth/microsoft] verify: forit-Auth unavailable', { status: outcome.status });
    return { kind: 'unavailable', status: outcome.status };
  }
  if (outcome.status === 200) {
    const principal = isObject(outcome.body) ? microsoftPrincipalFromIdentity(outcome.body.identity, binding) : null;
    if (principal) return { kind: 'ok', principal };
    console.error('[forit/auth/microsoft] verify answer failed its checks', { status: 200 });
    return { kind: 'failed', status: 200 };
  }
  if (outcome.status === 401 && isObject(outcome.body) && outcome.body.error === 'invalid_session') {
    return { kind: 'ended' };
  }
  console.error('[forit/auth/microsoft] verify refused', { status: outcome.status });
  return { kind: 'failed', status: outcome.status };
}

/** Revoke a handle. True only on 204; any other answer may leave it live at Auth until it expires. */
export async function revokeMicrosoftHandle(binding: MicrosoftExchangeBinding, handle: string): Promise<boolean> {
  const outcome = await call(binding, '/revoke', { session: handle });
  if (outcome.kind === 'no_caller') {
    console.error(
      '[forit/auth/microsoft] revoke: no Auth caller token; nothing was sent, and the session may stay live at forit-Auth until it expires',
      { code: outcome.code, retryable: outcome.retryable },
    );
    return false;
  }
  const status = outcome.status;
  if (outcome.kind === 'answer' && status === 204) return true;
  console.error('[forit/auth/microsoft] revoke not confirmed; the session may stay live at forit-Auth until it expires', {
    status,
  });
  return false;
}
