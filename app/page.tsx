import { getThemeForRequest } from "@/lib/tenant";
import { learningLabel, tenantDisplayName } from "@/lib/tenant-label";
import { getSessionUser } from "@/lib/get-session";
import DashboardPage from "@/app/dashboard/page";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await getSessionUser();
  if (session) {
    // Render the dashboard inline — avoids the prior 30x bounce that briefly
    // made the /learn redirect fragile on cross-subdomain sign-in. Per the
    // 2026-05-17 dashboard-redesign design doc.
    return <DashboardPage />;
  }

  const theme = await getThemeForRequest();
  const label = learningLabel(tenantDisplayName(theme), " ");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-white px-4">
      <div className="text-center max-w-sm w-full">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">{label}</h1>
          <p className="text-sm text-gray-500 mt-2">
            Training &amp; compliance for your team
          </p>
        </div>
        <a
          href="/api/auth/login?returnTo=/"
          className="inline-flex items-center justify-center gap-3 w-full bg-gray-900 text-white rounded-lg px-6 py-3 text-sm font-medium hover:bg-gray-800 transition-colors"
        >
          <svg className="w-5 h-5" viewBox="0 0 23 23" fill="none">
            <path d="M1 1h10v10H1z" fill="#f25022" />
            <path d="M12 1h10v10H12z" fill="#7fba00" />
            <path d="M1 12h10v10H1z" fill="#00a4ef" />
            <path d="M12 12h10v10H12z" fill="#ffb900" />
          </svg>
          Sign in with Microsoft
        </a>
      </div>
    </main>
  );
}
