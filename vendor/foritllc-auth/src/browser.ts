// ============================================================================
// @foritllc/auth - Browser/SPA Surface (0.2.1)
// Standalone, no imports from next/* or node-only globals. Safe to bundle
// into a Vite/Webpack/Rollup SPA. Lets msal-browser apps build the same
// TenantContext shape that Next.js consumers get from createGetTenantContext.
// ============================================================================

/**
 * Minimal shape of msal-browser's `AccountInfo` — typed structurally so this
 * file does not take a hard `@azure/msal-browser` peer dep. Pass the account
 * returned by `useMsal().accounts[0]` (or `instance.getAllAccounts()[0]`) and
 * the function reads `tenantId` / `idTokenClaims.tid` defensively.
 */
export interface MsalAccountLike {
  tenantId?: string;
  idTokenClaims?: { tid?: unknown; [key: string]: unknown };
  username?: string;
}

/**
 * Resolution-key bundle for tenant-theme + branded email — browser variant.
 * Same field names as the server-side `TenantContext` from `tenant-context.ts`
 * so SPAs and Next.js apps can pass the result into `resolveTenantTheme`
 * without any conditional plumbing.
 */
export interface BrowserTenantContext {
  /** Azure AD tenant id from the signed-in MSAL account. */
  tid?: string;
  /** ForIT-internal tenant UUID — populated by the caller from app state if known; this helper does not resolve it. */
  tenant_id?: string;
  /** Lowercased host (port stripped). Pass `location.hostname` from the SPA. */
  hostname?: string;
}

/**
 * Synchronous helper that turns an MSAL browser account + the current
 * hostname into the `TenantContext` shape consumed by `@foritllc/tenant-theme`.
 *
 * Usage in a Vite/React SPA:
 * ```ts
 * import { useMsal } from '@azure/msal-react';
 * import { tenantContextFromMsalAccount } from '@foritllc/auth/browser';
 * import { createStaticTenantThemeResolver } from '@foritllc/tenant-theme';
 *
 * const { accounts } = useMsal();
 * const ctx = tenantContextFromMsalAccount(accounts[0], window.location.hostname);
 * const theme = resolveTheme(ctx); // sync registry resolver, browser-safe
 * ```
 */
export function tenantContextFromMsalAccount(
  account: MsalAccountLike | null | undefined,
  hostname?: string,
): BrowserTenantContext {
  const claimTid =
    account?.idTokenClaims && typeof account.idTokenClaims.tid === 'string'
      ? account.idTokenClaims.tid
      : undefined;
  const tid =
    typeof account?.tenantId === 'string' && account.tenantId.length > 0
      ? account.tenantId
      : claimTid;

  const host =
    typeof hostname === 'string' && hostname.length > 0
      ? hostname.toLowerCase().split(':')[0]
      : undefined;

  return { tid, hostname: host };
}
