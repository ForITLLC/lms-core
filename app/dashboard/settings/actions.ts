"use server";

import { recordError } from "@/lib/logging";
import { getSessionUser } from "@/lib/get-session";
import { addressPepperFromEnv, isEmailCategory, optOutStore, optOutSubject } from "@/lib/email-optout";

export type EmailPreferenceResult = { ok: true } | { ok: false; error: string };

// The account switch writes the same lms.EmailOptOuts row the email's unsubscribe link writes.
export async function setEmailPreference(category: string, on: boolean): Promise<EmailPreferenceResult> {
  const session = await getSessionUser();
  if (!session?.tenantId) return { ok: false, error: "Sign in again to change your email settings." };
  if (!isEmailCategory(category) || typeof on !== "boolean") return { ok: false, error: "That setting doesn't exist." };
  try {
    const pepper = addressPepperFromEnv();
    if (!pepper) throw new Error("EMAIL_ADDRESS_PEPPER is not configured");
    const who = optOutSubject(session.tenantId, session.email, pepper);
    if (on) await optOutStore().setOn(who, category, "account");
    else await optOutStore().setOff(who, category, "account");
    return { ok: true };
  } catch (error) {
    await recordError("lms-email-settings", `could not save ${category}: ${error instanceof Error ? error.message : String(error)}`, "ERROR")
      .catch(() => undefined);
    return { ok: false, error: "That change was not saved. Try again." };
  }
}
