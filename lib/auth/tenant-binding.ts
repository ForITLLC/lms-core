import { verifiedSessionEmail, type BaseSession } from "@foritllc/auth";

export interface TenantCandidate {
  TenantId: string;
  AadTenantId: string | null;
  Domain: string | null;
}

export type BindingIdentity = Pick<BaseSession, "tid" | "isGuest" | "email" | "emailVerified">;

// Security T-11: the Entra tenant id is the identity, the email is a label.
// A tenant row with AadTenantId set only ever accepts sign-ins from that
// directory. A row without one binds by email domain, and only when
// @foritllc/auth 0.7.0 has verified that domain in the signer's tenant.
export function chooseTenantBinding(rows: readonly TenantCandidate[], who: BindingIdentity): string | null {
  const tid = who.tid?.toLowerCase();
  if (!tid || who.isGuest === true) return null;

  const pinned = rows.find((r) => r.AadTenantId?.toLowerCase() === tid);
  if (pinned) return pinned.TenantId;

  const domain = verifiedSessionEmail(who)?.split("@")[1];
  if (!domain) return null;
  const byDomain = rows.find((r) => !r.AadTenantId && r.Domain?.toLowerCase() === domain);
  return byDomain?.TenantId ?? null;
}
