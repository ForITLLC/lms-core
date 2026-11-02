// The hosted service gives its own operator tenant fixed marks. A public
// install has no such tenant: every tenant, whatever its slug, shows the
// logos on its own lms.TenantBranding row.
export function isForitTenant(_slug: string | null | undefined): boolean {
  return false;
}

export const FORIT_HEX_WHITE_PATH = "";
export const FORIT_MARK_COLOR_PATH = "";

export function foritMark(_file: string): { contentType: string; bytes: Buffer } | null {
  return null;
}

export function foritEmailLockup(): string {
  throw new Error("no operator tenant marks in this build");
}
