// ============================================================================
// @foritllc/auth - returnTo guard (0.8.0)
//
// The callback sends the browser to `new URL(returnTo, baseUrl)`. Before
// 0.8.0 the only check was "starts with `/`, not `//`", which let
// `/\evil.example` and `/\t/evil.example` through: the WHATWG URL parser
// treats `\` as `/` and deletes tab/newline, so both resolve off-origin.
// ============================================================================

const PROBE_ORIGIN = 'https://same-origin.invalid';

/**
 * Return `raw` if it is a path on THIS origin, else `fallback`.
 *
 * Accepted: a string that starts with exactly one `/`, contains no backslash,
 * whitespace or control character, and still resolves to the same origin.
 * Refused: absolute URLs, `//host`, `/\host`, `javascript:`/`data:` and any
 * other scheme, relative paths without a leading slash, non-strings.
 *
 * Use it for every redirect target that came from a request (query string,
 * OAuth state, form field) — not only the sign-in.
 */
export function safeReturnTo(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return fallback;
  if (/[\\\s\u0000-\u001f\u007f]/.test(raw)) return fallback;
  try {
    if (new URL(raw, PROBE_ORIGIN).origin !== PROBE_ORIGIN) return fallback;
  } catch {
    return fallback;
  }
  return raw;
}
