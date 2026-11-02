import { renderLearningDigest, renderLearningDigestText } from "@/lib/digest-email";
import type { BrandedEmailOptions, BrandingOverride, InlineImageAttachment } from "@/lib/vendor/email";
import { SUMMARY_CATEGORIES, type LearningSummary, type SummarySection } from "@/lib/learning-summary";

const LABELS = { due: "Training due soon", overdue: "Overdue training", completions: "Completions", new_assignments: "New assignments" };
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export function summarySubject(brandName: string): string { return `[${brandName} Learning] Your learning summary`; }

export interface SummaryMailLinks { unsubscribeUrl: string; preferencesUrl: string }

export function renderSummaryEmail(tenant: { slug: string; name: string; branding: BrandingOverride; logoDataUri: string | null }, summary: LearningSummary, summaryUrl: string,
  recipient: { displayName: string; photo: InlineImageAttachment | null } = { displayName: "", photo: null }, links?: SummaryMailLinks) {
  const sections: BrandedEmailOptions["sections"] = [];
  const initials = recipient.displayName.trim().split(/\s+/).slice(0, 2).map(word => word[0] ?? "").join("").toUpperCase() || "?";
  sections.push({ emoji: "", title: "Your learning update", content: recipient.photo
    ? `<p><img src="cid:${escape(recipient.photo.contentId)}" alt="${escape(recipient.displayName || "Your profile photo")}" width="48" height="48" style="border-radius:24px;vertical-align:middle"/> <strong>${escape(recipient.displayName)}</strong></p>`
    : `<p><span aria-label="Profile initials" style="display:inline-block;font-weight:700;padding:12px;border:1px solid currentColor;border-radius:24px">${escape(initials)}</span> <strong>${escape(recipient.displayName)}</strong></p>` });
  const add = (section: SummarySection, prefix: string, team: boolean) => {
    for (const category of SUMMARY_CATEGORIES) {
      const items = section[category];
      if (!items.length) continue;
      sections.push({ emoji: "", title: `${prefix}${LABELS[category]} (${items.length})`, content:
        `<ul>${items.map(item => `<li>${team ? `${escape(item.learner_name)}: ` : ""}${escape(item.course_title)}${item.due_date ? ` · due ${escape(item.due_date.slice(0, 10))}` : ""}${item.occurred_at ? ` · ${escape(item.occurred_at.slice(0, 10))}` : ""}</li>`).join("")}</ul>` });
    }
  };
  add(summary.personal, "Your ", false);
  if (summary.team) add(summary.team, summary.team.scope === "admin" ? "Organisation: " : "Your team: ", true);
  sections.push({ emoji: "", title: "Open your learning summary", content: `<p><a href="${escape(summaryUrl)}">Review training and recent activity</a></p>` });
  const content = { title: "Your learning summary", subtitle: `Updates since ${summary.window_start.slice(0, 10)}`,
    preheader: "Training due, overdue, completed and newly assigned in one summary", sections,
    footerText: `${tenant.name} Learning · daily summary`, footerSubtext: "One daily email brings your learning updates together.",
    ...(links ? { footer: { unsubscribe: { url: links.unsubscribeUrl, label: "Unsubscribe from learning summary emails" },
      managePreferences: { url: links.preferencesUrl, label: "Manage email settings" } } } : {}) };
  const attachments = recipient.photo ? [recipient.photo] : [];
  return { ...renderLearningDigest(tenant, content, attachments), ...renderLearningDigestText(tenant, content, attachments) };
}

export async function fetchSummaryMailToken(): Promise<string> {
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (endpoint && header) {
    const response = await fetch(`${endpoint}?api-version=2019-08-01&resource=https://graph.microsoft.com/`, { headers: { "X-IDENTITY-HEADER": header } });
    if (response.ok) return ((await response.json()) as { access_token: string }).access_token;
  }
  const { AZURE_CLIENT_ID: clientId, AZURE_CLIENT_SECRET: secret, AZURE_TENANT_ID: tenantId } = process.env;
  if (!clientId || !secret || !tenantId) throw new Error("learning-summary: no Graph credentials");
  const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: secret, scope: "https://graph.microsoft.com/.default" }),
  });
  if (!response.ok) throw new Error(`learning-summary: token endpoint HTTP ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}
