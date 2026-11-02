// ============================================================================
// @foritllc/auth - Session Cookie Signing (HMAC-SHA256)
// Uses Web Crypto API for Edge Runtime compatibility (middleware).
// Cookie format: {base64_payload}.{hex_hmac_signature}
// ============================================================================

// 0.12.0 (for-AVHR finding, 2026-10-25): App Service puts the literal
// `@Microsoft.KeyVault(SecretUri=...)` text in the variable when a Key Vault
// reference does not resolve. That text is in the app's settings and its
// templates, so a cookie signed with it can be forged by anyone who has read
// them. Any `@Microsoft.<Provider>(` value (App Configuration references too)
// is refused, never used as a key.
const UNRESOLVED_REFERENCE = /^\s*@Microsoft\.[A-Za-z]+\s*\(/i;

const GENERATE_HINT =
  "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"";

/**
 * Why `secret` must not sign sessions, or null when it may. Refuses a missing
 * or blank value and an unresolved Key Vault / App Configuration reference.
 */
export function sessionSecretProblem(secret: string | undefined): string | null {
  if (!secret || !secret.trim()) {
    return `SESSION_SECRET environment variable is required. ${GENERATE_HINT}`;
  }
  if (UNRESOLVED_REFERENCE.test(secret)) {
    return (
      'SESSION_SECRET is an unresolved reference (it starts with "@Microsoft."), not a secret: ' +
      'the platform could not read the Key Vault secret, so it passed the reference text through. ' +
      "Fix the app's managed identity access to the vault or the reference itself, then restart. " +
      'Sessions are never signed with the reference text.'
    );
  }
  return null;
}

/**
 * Throw when SESSION_SECRET cannot sign sessions (see sessionSecretProblem).
 * The middleware and route factories call this when they are created, so a
 * bad secret stops the app at startup instead of signing forgeable cookies.
 * Skipped during `next build` (NEXT_PHASE=phase-production-build), which loads
 * route modules but serves nothing and has no runtime settings; signing and
 * verifying still refuse the same values on every call.
 */
export function assertSessionSecret(): void {
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const problem = sessionSecretProblem(process.env.SESSION_SECRET);
  if (problem) throw new Error(`[forit/auth] ${problem}`);
}

function getSecretBytes(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  const problem = sessionSecretProblem(secret);
  if (problem) throw new Error(`[forit/auth] ${problem}`);
  return new TextEncoder().encode(secret);
}

async function getHmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    getSecretBytes() as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Sign a base64-encoded session payload with HMAC-SHA256.
 * Returns: "{base64_payload}.{hmac_hex}"
 */
export async function signSessionPayload(
  base64Payload: string
): Promise<string> {
  const key = await getHmacKey();
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(base64Payload)
  );
  return `${base64Payload}.${toHex(signature)}`;
}

/**
 * Verify a signed cookie value and return the base64 payload.
 * Returns null if the signature is invalid or missing.
 */
export async function verifySessionPayload(
  cookieValue: string
): Promise<string | null> {
  const dotIndex = cookieValue.lastIndexOf('.');
  if (dotIndex === -1) return null;

  const base64Payload = cookieValue.substring(0, dotIndex);
  const signatureHex = cookieValue.substring(dotIndex + 1);

  // HMAC-SHA256 produces 64 hex characters
  if (signatureHex.length !== 64) return null;

  try {
    const key = await getHmacKey();
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      fromHex(signatureHex) as unknown as ArrayBuffer,
      new TextEncoder().encode(base64Payload)
    );
    return valid ? base64Payload : null;
  } catch {
    return null;
  }
}
