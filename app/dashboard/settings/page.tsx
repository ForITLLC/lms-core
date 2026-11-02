import type { FC, ReactNode } from "react";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/Card";
import ShellRaw from "@/components/Shell";
import EmailSettings from "@/components/EmailSettings";
import { getSessionUser } from "@/lib/get-session";
import { addressPepperFromEnv, EMAIL_CATEGORIES, optOutStore, optOutSubject } from "@/lib/email-optout";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;
export const dynamic = "force-dynamic";

async function emailCategories(tenantId: string, email: string) {
  const pepper = addressPepperFromEnv();
  if (!pepper) return null;
  try {
    const off = await optOutStore().list(optOutSubject(tenantId, email, pepper));
    return EMAIL_CATEGORIES.map(category => ({ key: category.key, label: category.label, description: category.description,
      on: !off.some(entry => entry.category === category.key) }));
  } catch {
    return null;
  }
}

export default async function SettingsPage() {
  const session = await getSessionUser();
  if (!session) redirect("/api/auth/login?returnTo=/dashboard/settings");
  if (!session.tenantId) return <Shell title="Settings"><p>Your sign-in needs an organisation. Sign out and back in, or contact your administrator.</p></Shell>;
  const categories = await emailCategories(session.tenantId, session.email);
  return (
    <Shell title="Settings">
      <Card variant="white" padding="lg">
        <h2 className="text-lg font-semibold text-gray-900">Email</h2>
        <p className="mt-1 mb-4 text-gray-600">Choose the emails you get at {session.email}. The unsubscribe link in each email changes the same setting.</p>
        {categories ? <EmailSettings categories={categories} /> : <p className="text-gray-600">Email settings aren&apos;t available right now. Try again later.</p>}
      </Card>
    </Shell>
  );
}
