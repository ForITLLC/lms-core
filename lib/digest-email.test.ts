import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMailClient } from "./vendor/mail";
import { renderLearningDigest } from "./digest-email";

const png = readFileSync(new URL("./fixtures/email.png", import.meta.url)).toString("base64");
const tenant = { name: "Operator Learning", logoDataUri: `data:image/png;base64,${png}`, branding: {
  name: "Operator Learning", primaryColor: "#234567", secondaryColor: "#345678", accentColor: "#aabbcc", supportEmail: "help@example.test",
} };
const document = { title: "Required learning", subtitle: "Daily digest", sections: [{ emoji: "", title: "Required", content: "<table><tr><td>Flight safety</td></tr></table>" }], footerText: "Operator Learning · daily digest" };

test("digest renderer returns small tenant CID bytes with the content and footer", () => {
  const rendered = renderLearningDigest(tenant, document);
  assert.match(rendered.html, /Flight safety/);
  assert.match(rendered.html, /Operator Learning/);
  assert.doesNotMatch(rendered.html, /src=["'](?:data:|https?:)/);
  assert.equal(rendered.attachments.length, 1);
  const image = rendered.attachments[0]!;
  assert.match(rendered.html, new RegExp(`cid:${image.contentId}`));
  assert.equal(image.contentBytes, png);
  assert.equal(image.contentType, "image/png");
  assert.equal(image.isInline, true);
  assert.ok(Buffer.from(image.contentBytes, "base64").length < 40960);
});

test("missing or unusable tenant artwork never falls through to a ForIT mark", () => {
  for (const logoDataUri of [null, "https://example.test/logo.svg"]) {
    const rendered = renderLearningDigest({ ...tenant, logoDataUri }, document);
    assert.match(rendered.html, /Operator Learning/);
    assert.doesNotMatch(rendered.html, /cid:forit-|src=["'](?:data:|https?:)/);
    assert.equal(rendered.attachments.length, 0);
  }
});

test("shared sender retains the rendered digest image in the final Graph payload", async () => {
  const originalFetch = globalThis.fetch;
  let payload: any;
  globalThis.fetch = async (_url, init) => { payload = JSON.parse(String(init?.body)); return new Response(null, { status: 202 }); };
  try {
    const mail = createMailClient(async () => "synthetic-token");
    const rendered = renderLearningDigest(tenant, document);
    const result = await mail.send({ from: "sender@example.test", to: ["learner@example.test"], subject: "Learning", ...rendered });
    assert.equal(result.ok, true);
    assert.equal(payload.message.attachments.length, 1);
    assert.equal(payload.message.attachments[0].contentBytes, png);
    assert.equal(payload.message.attachments[0].isInline, true);
    assert.match(payload.message.body.content, new RegExp(`cid:${payload.message.attachments[0].contentId}`));
    assert.equal(payload.message.from.emailAddress.address, "sender@example.test");
    assert.equal(payload.message.toRecipients[0].emailAddress.address, "learner@example.test");
  } finally { globalThis.fetch = originalFetch; }
});

test("unified summary caller retains tenant CID artwork and all personal/team categories", async () => {
  const { renderSummaryEmail } = await import("./summary-email");
  const item = { id: "1", course_id: "C", course_slug: "flight", course_title: "Flight safety", learner_id: "L", learner_name: "Learner", learner_email: "learner@example.test", due_date: "2026-10-20T00:00:00Z", occurred_at: "2026-10-18T12:00:00Z" };
  const section = { due: [item], overdue: [item], completions: [item], new_assignments: [item] };
  const rendered = renderSummaryEmail({ ...tenant, slug: "operator" }, { generated_at: "2026-10-18T16:00:00Z", window_start: "2026-10-17T16:00:00Z", personal: section, team: { ...section, scope: "manager" } }, "https://operator.example.test/dashboard/summary");
  for (const text of ["Flight safety", "Training due soon", "Overdue training", "Completions", "New assignments", "Your team", "Operator Learning", "https://operator.example.test/dashboard/summary"]) assert.ok(rendered.html.includes(text), text);
  assert.equal(rendered.attachments.length, 1);
  assert.equal(rendered.attachments[0]!.contentBytes, png);
  assert.match(rendered.html, new RegExp(`cid:${rendered.attachments[0]!.contentId}`));
  assert.doesNotMatch(rendered.html, /src=["'](?:data:|https?:)/);
});
