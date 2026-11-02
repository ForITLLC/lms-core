import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderSummaryEmail } from "./summary-email";
import type { LearningSummary, SummaryItem } from "./learning-summary";

const row: SummaryItem = { id: "1", learner_id: "L", learner_name: "Learner <A>", learner_email: "a@example.test", course_id: "C", course_slug: "course", course_title: "Safety <script>alert(1)</script>", due_date: "2026-10-18T00:00:00Z", occurred_at: "2026-10-18T10:00:00Z" };
const section = { due: [row], overdue: [row], completions: [row], new_assignments: [row] };
const summary: LearningSummary = { generated_at: "2026-10-18T16:00:00Z", window_start: "2026-10-17T16:00:00Z", personal: section, team: { ...section, scope: "manager" } };

test("combined branded email contains every personal/team category with escaped text and tenant summary link", () => {
  const rendered = renderSummaryEmail({ slug: "operator", name: "Operator", logoDataUri: null,
    branding: { name: "Operator", primaryColor: "#234567", secondaryColor: "#345678", accentColor: "#456789" } }, summary, "https://operator.learn.forit.io/dashboard/summary");
  for (const text of ["Training due soon", "Overdue training", "Completions", "New assignments", "Your team", "Learner &lt;A&gt;", "https://operator.learn.forit.io/dashboard/summary"]) assert.ok(rendered.html.includes(text), text);
  assert.doesNotMatch(rendered.html, /<script>|cid:forit-/);
  assert.equal(rendered.attachments.length, 0);
});

test("recipient portrait uses CID bytes alongside existing tenant brand artwork, with explicit initials fallback", () => {
  const bytes = readFileSync(new URL("./fixtures/email.png", import.meta.url)).toString("base64");
  const tenant = { slug: "operator", name: "Operator", logoDataUri: `data:image/png;base64,${bytes}`,
    branding: { name: "Operator", primaryColor: "#234567", secondaryColor: "#345678", accentColor: "#456789" } };
  const photo = { contentId: "learning-recipient-portrait", contentBytes: bytes, contentType: "image/png", name: "recipient.png", isInline: true as const };
  const rendered = renderSummaryEmail(tenant, summary, "https://operator.example.test/dashboard/summary", { displayName: "Pat Example", photo });
  assert.equal(rendered.attachments.length, 2);
  assert.equal(rendered.attachments.at(-1)!.contentId, photo.contentId);
  for (const attachment of rendered.attachments) assert.ok(rendered.html.includes(`cid:${attachment.contentId}`));
  assert.doesNotMatch(rendered.html, /src=["'](?:data:|https?:)/);
  const fallback = renderSummaryEmail(tenant, summary, "https://operator.example.test/dashboard/summary", { displayName: "Pat Example", photo: null });
  assert.match(fallback.html, /Profile initials/);
  assert.match(fallback.html, />PE<\/span>/);
  assert.equal(fallback.attachments.length, 1);
});
