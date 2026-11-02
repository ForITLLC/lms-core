import type { AuthConfig } from "@foritllc/auth";
import { requestHost } from "@/lib/request-host";

export type Role = "admin" | "author" | "learner" | "instructor" | "training_manager";

export interface LmsSession {
  email: string;
  name: string;
  azureOid: string;
  tid?: string;
  expiresAt: number;
  tenantId?: string;
  role?: Role;
  // AAD security-group ids the user belongs to (transitive), stamped at
  // sign-in by lib/auth-config-server.ts. Empty when the tenant has no
  // HrAdminAdGroupId configured or Graph lookup fails. Used by
  // lib/db/curriculum.ts:getRequiredCurriculaForGroups to derive
  // group-driven required training without re-hitting Graph on every page.
  groups?: string[];
}

// `req` typed as `any` to dodge the NextRequest identity mismatch between
// forit-Common's pinned `next` and the app's own — same workaround AvOps
// applies (commit 783a257). The deploy workflow strips
// forit-Common/node_modules/next so this isn't a runtime concern, only a
// local typecheck one.
function deriveOrigin(req: any): string {
  const host = requestHost(req.headers) ?? "localhost:3000";
  const proto = host.startsWith("localhost") ? "http" : "https";
  return `${proto}://${host}`;
}

// Edge-safe AuthConfig — imported by middleware, login/logout/me handlers, and
// lib/get-session. Intentionally OMITS onSessionCreated so the edge bundle
// doesn't drag in tedious (node:url). The callback route imports
// lib/auth-config-server which layers onSessionCreated on top.
//
// LMS is white-label multi-tenant: any AAD tenant can sign in
// (allowedTenantIds=false), and tenant binding happens server-side via
// lms.Tenant + lms.TenantDomain lookup in onSessionCreated. cookieDomain is
// host-only (undefined) because one app serves BOTH the ForIT-owned
// pattern (*.learn.forit.io) AND foreign-domain tenants like
// learn.operator.example — there's no shared parent. The cross-subdomain
// SSO that used Domain=.learn.forit.io is the regression here: an admin
// hopping between <other>.learn.forit.io subdomains will re-prompt. Acceptable
// because (a) tenants live on their own dedicated host and rarely roam, and
// (b) the alternative is per-host config which @foritllc/auth doesn't yet
// support as a function. Override via LMS_COOKIE_DOMAIN if needed.
export const authConfig: AuthConfig = {
  clientId: process.env.AZURE_AD_CLIENT_ID ?? "",
  clientSecret: process.env.AZURE_AD_CLIENT_SECRET ?? "",
  tenantId: process.env.AZURE_AD_TENANT_ID ?? "organizations",
  allowedTenantIds: false,
  rejectGuests: true,
  redirectUri: (req) => `${deriveOrigin(req)}/api/auth/callback`,
  baseUrl: (req) => deriveOrigin(req),
  // _v2 (Security T-11): sessions minted before @foritllc/auth 0.7.0 were bound
  // to a tenant from an unverified email, so they are retired, not trusted.
  cookieName: "forit_lms_session_v2",
  cookieDomain: process.env.LMS_COOKIE_DOMAIN || undefined,
  sessionMaxAge: 30 * 24 * 60 * 60,
  protectedPaths: [
    "/dashboard",
    "/learn",
    "/drill",
    "/author",
    "/admin",
    "/api/admin",
    "/api/author",
    "/api/learner",
    "/api/courses",
    "/api/ai",
    "/api/users",
  ],
  publicPaths: [
    "/",
    "/api/auth",
    "/api/health",
    "/api/unsubscribe",
    "/api/version",
    "/certificate",
    "/api/external",
    "/api/v1",
    "/api/mobile",
    "/api/openapi.json",
    "/api/mcp-manifest.json",
  ],
  defaultReturnTo: "/dashboard",
};
