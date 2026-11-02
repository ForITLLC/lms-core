import * as sqlConnection from "@/lib/db/connection";
import {
  createSqlOptOutStore,
  createUnsubscribeKeyring,
  subjectForAddress,
  unsubscribeLink,
  type OptOutDb,
  type OptOutStore,
  type OptOutSubject,
  type UnsubscribePageOptions,
  type UnsubscribeKeyring,
} from "@/lib/vendor/mail";
import { getTenantProfile } from "@/lib/db/tenants";

// every-form-every-email (for-Common docs/patterns/every-form-every-email.md):
// one store (lms.EmailOptOuts) behind the signed link, the one-click POST, the
// account switch and the send-time check.
export const MAIL_PURPOSE = "lms-mail";
export const LEARNING_SUMMARY = "learning-summary";

export const EMAIL_CATEGORIES = [
  {
    key: LEARNING_SUMMARY,
    label: "Learning summary",
    description: "One email a day with training due, overdue, completed and newly assigned.",
    pageLabel: "learning summary emails",
  },
] as const;

export function isEmailCategory(value: unknown): value is (typeof EMAIL_CATEGORIES)[number]["key"] {
  return EMAIL_CATEGORIES.some(category => category.key === value);
}

const KEY_PREFIX = "EMAIL_UNSUBSCRIBE_KEY_";

// App Service leaves the literal reference in the variable when a Key Vault
// reference fails to resolve. That string is long enough to pass as a secret
// and is public, so it must never sign a link.
function resolved(name: string, value: string): string {
  if (value.trim().startsWith("@Microsoft.KeyVault(")) throw new Error(`${name} is an unresolved Key Vault reference`);
  return value;
}

/**
 * EMAIL_UNSUBSCRIBE_KEY_<ID> holds each signing key, EMAIL_UNSUBSCRIBE_CURRENT_KEY
 * names the one that signs. To rotate, add a key and make it current; keep the
 * old one until its links expire (180 days). Null when none is configured.
 */
export function unsubscribeKeyringFromEnv(env: Record<string, string | undefined> = process.env): UnsubscribeKeyring | null {
  const keys: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith(KEY_PREFIX) && value) keys[name.slice(KEY_PREFIX.length).toLowerCase()] = resolved(name, value);
  }
  const current = env.EMAIL_UNSUBSCRIBE_CURRENT_KEY?.trim().toLowerCase() ?? "";
  if (!current && Object.keys(keys).length === 0) return null;
  return createUnsubscribeKeyring({ current, keys });
}

/**
 * Most recipients are learners with no LMS account, so every LMS opt-out is
 * keyed by address. Never rotate the pepper: a new one orphans every stored
 * opt-out.
 */
export function addressPepperFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.EMAIL_ADDRESS_PEPPER;
  return value ? resolved("EMAIL_ADDRESS_PEPPER", value) : null;
}

export function optOutSubject(tenantId: string, address: string, pepper: string): OptOutSubject {
  const tenant = tenantId.toLowerCase();
  return { tenant, subject: subjectForAddress(tenant, address, pepper) };
}

let store: OptOutStore | null = null;
export function optOutStore(): OptOutStore {
  store ??= createSqlOptOutStore({ schema: "lms", db: sqlConnection as unknown as OptOutDb });
  return store;
}

// Mirrors lib/tenant.ts: the apex itself serves the apex tenant, which has no <slug>.<apex> host.
export function tenantOrigin(tenant: { slug: string; customHostname: string | null }): string {
  const apex = process.env.LMS_APEX_DOMAIN ?? "learn.forit.io";
  const apexSlug = (process.env.LMS_APEX_TENANT_SLUG ?? "forit").toLowerCase();
  if (tenant.customHostname) return `https://${tenant.customHostname}`;
  return tenant.slug.trim().toLowerCase() === apexSlug ? `https://${apex}` : `https://${tenant.slug}.${apex}`;
}

export function preferencesUrl(origin: string): string {
  return `${origin}/dashboard/settings`;
}

export function unsubscribeUrl(origin: string, keyring: UnsubscribeKeyring, who: OptOutSubject, category: string): string {
  const link = unsubscribeLink({ baseUrl: `${origin}/api/unsubscribe`, keyring, purpose: MAIL_PURPOSE, who, category });
  if (!link) throw new Error("No unsubscribe keyring");
  return link.url;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The unsubscribe page for a verified token's tenant: its own name and colour, never ForIT's. */
export async function unsubscribePage(tenant: string): Promise<UnsubscribePageOptions> {
  const profile = await getTenantProfile(tenant);
  if (!profile) throw new Error("Unsubscribe link for an unknown or inactive tenant");
  return {
    productName: `${profile.CompanyName ?? profile.Name} Learning`,
    ...(profile.PrimaryColor && HEX.test(profile.PrimaryColor) ? { primaryColor: profile.PrimaryColor } : {}),
    accountUrl: preferencesUrl(tenantOrigin({ slug: profile.Slug, customHostname: profile.CustomHostname })),
    categoryLabels: Object.fromEntries(EMAIL_CATEGORIES.map(category => [category.key, category.pageLabel])),
  };
}
