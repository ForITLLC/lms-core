import Link from "next/link";
import type { ReactNode } from "react";
import { getThemeForRequest } from "@/lib/tenant";
import { FORIT_HEX_WHITE_PATH, isForitTenant } from "@/lib/forit-brand";
import { learningLabel, tenantDisplayName } from "@/lib/tenant-label";
import { getSessionUser } from "@/lib/get-session";
import Avatar from "./Avatar";
import MobileNav from "./MobileNav";
import { navItemsFor } from "./nav-items";

interface ShellProps {
  children: ReactNode;
  title?: string;
}

export default async function Shell({ children, title }: ShellProps) {
  const [theme, session] = await Promise.all([
    getThemeForRequest(),
    getSessionUser(),
  ]);
  const forit = isForitTenant(theme.slug);
  const logoUrl = forit ? undefined : theme.logo_url;
  const name = tenantDisplayName(theme);
  const label = learningLabel(name);

  const navItems = session ? navItemsFor(session.role) : [];

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <header
        className="text-white shadow-md sticky top-0 z-50"
        style={{ backgroundColor: "var(--brand-primary)" }}
      >
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between min-h-[3.5rem] py-2 gap-3">
            <Link
              href={session ? "/dashboard" : "/"}
              prefetch={false}
              className="flex items-center gap-3 hover:opacity-90 transition-opacity min-w-0"
            >
              {forit ? (
                <img src={FORIT_HEX_WHITE_PATH} alt={name ?? "ForIT"} className="h-8 w-auto" />
              ) : logoUrl ? (
                <img
                  src={logoUrl}
                  alt={name ?? ""}
                  className="h-8 w-auto brightness-0 invert"
                />
              ) : name ? (
                <div
                  className="h-9 w-9 rounded-lg flex items-center justify-center text-white font-semibold flex-shrink-0"
                  style={{ backgroundColor: "rgba(255,255,255,0.18)" }}
                >
                  {name.charAt(0)}
                </div>
              ) : null}
              <span className="text-sm font-semibold tracking-wide truncate">
                {logoUrl ? "Learning" : label}
              </span>
            </Link>

            {session ? (
              <>
                <nav className="hidden md:flex items-center gap-1">
                  {navItems
                    .filter((it) => it.href !== "/api/auth/logout")
                    .map((it) => (
                      <Link
                        key={it.href}
                        href={it.href}
                        prefetch={false}
                        className="rounded-md px-3 py-1.5 text-sm font-medium hover:bg-white/10 transition-colors"
                      >
                        {it.label}
                      </Link>
                    ))}
                  <span className="text-xs opacity-80 ml-2 mr-1 hidden lg:inline">
                    {session.email}
                  </span>
                  <Avatar
                    oid={session.azureOid}
                    name={session.name ?? session.email}
                    size={32}
                  />
                  <Link
                    href="/api/auth/logout"
                    prefetch={false}
                    className="rounded-md px-3 py-1.5 text-sm font-semibold bg-white/10 hover:bg-white/20 transition-colors ml-1"
                  >
                    Sign out
                  </Link>
                </nav>
                <MobileNav items={navItems} email={session.email} />
              </>
            ) : (
              <Link
                href="/api/auth/login?returnTo=/dashboard"
                prefetch={false}
                className="rounded-md px-4 py-2 text-sm font-semibold bg-white/10 hover:bg-white/20 transition-colors"
              >
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 w-full">
        {title ? (
          <div className="max-w-[1400px] mx-auto w-full px-4 sm:px-6 lg:px-8 py-6">
            <h1
              className="text-2xl font-semibold mb-5 pb-3 border-b border-gray-200"
              style={{ color: "var(--brand-primary)" }}
            >
              {title}
            </h1>
            {children}
          </div>
        ) : (
          children
        )}
      </main>

      <footer className="text-center text-xs text-gray-500 py-4 border-t border-gray-200 bg-white">
        {label}
      </footer>
    </div>
  );
}
