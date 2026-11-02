// The host a request was sent to. App Service routes by Host, so Host is
// always a hostname bound to this app; X-Forwarded-Host is whatever the client
// chose to send, and trusting it let any caller pick another tenant's site or
// the sign-in redirect host. A self-hosted install behind a proxy that
// rewrites Host sets LMS_TRUST_FORWARDED_HOST=true and must have that proxy
// overwrite the header.
export function requestHost(
  h: Pick<Headers, "get">,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.LMS_TRUST_FORWARDED_HOST === "true") {
    const forwarded = h.get("x-forwarded-host")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return h.get("host");
}
