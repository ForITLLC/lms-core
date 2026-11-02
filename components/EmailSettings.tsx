"use client";

import { EmailPreferences } from "@/components/EmailPreferences";
import type { EmailPreferenceCategory } from "@/lib/email-preferences";
import { setEmailPreference } from "@/app/dashboard/settings/actions";

export default function EmailSettings({ categories }: { categories: EmailPreferenceCategory[] }) {
  return (
    <EmailPreferences
      categories={categories}
      onChange={async (key, on) => {
        const result = await setEmailPreference(key, on);
        if (!result.ok) throw new Error(result.error);
      }}
    />
  );
}
