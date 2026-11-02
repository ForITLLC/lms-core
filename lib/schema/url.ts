// Addresses an author supplies end up in an href, src or iframe src, so only
// http(s) and site paths are allowed. zod's url() accepts any scheme new URL()
// parses (javascript:, data:, vbscript:), and new URL() drops leading spaces
// before parsing, so the scheme is checked on the raw string as well.
// No zod import here: the learner player imports these into the browser.

const WEB_SCHEME = /^https?:\/\//i;

export function isWebUrl(value: unknown): value is string {
  if (typeof value !== "string" || !WEB_SCHEME.test(value)) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

// A file on this site, e.g. /images/courses/categories/security.svg. A second
// leading slash would make it //host, another site.
const SITE_PATH = /^\/(?!\/)[\w\-./]+$/;

export function isSitePath(value: unknown): value is string {
  return typeof value === "string" && SITE_PATH.test(value);
}

export function isImageSource(value: unknown): value is string {
  return isWebUrl(value) || isSitePath(value);
}
